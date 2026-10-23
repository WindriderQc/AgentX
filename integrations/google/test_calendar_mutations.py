import copy
import json
import unittest
from unittest.mock import patch
from types import SimpleNamespace
from urllib.error import HTTPError, URLError
from calendar_provider import operate, CalendarError, gog_call
from calendar_conditional import conditional_patch, cached_native_token

MARKER = 'axm' + 'a' * 32
FINGERPRINT = 'b' * 64


class NativeFixture:
    def __init__(self, event=None):
        self.event = event or {'id': 'fixture', 'etag': '"v1"', 'status': 'confirmed',
            'summary': 'Fixture', 'organizer': {'email': 'owner@example.test', 'self': True},
            'extendedProperties': {'private': {'agentxRequest': 'creation-fingerprint', 'unrelated': 'retained'}, 'shared': {'other': 'retained'}}}
        self.calls = []
        self.race = False
        self.lose_response = False

    def __call__(self, method, params, body=None, headers=None):
        self.calls.append((method, copy.deepcopy(params), copy.deepcopy(body), headers))
        if method == 'events.get':
            return copy.deepcopy(self.event)
        assert method == 'events.patch'
        if self.race:
            self.event['etag'] = '"concurrent"'
        if headers != {'If-Match': self.event['etag']}:
            raise CalendarError('PERSONAL_CALENDAR_CONFLICT', 'Concurrent edit')
        for key, value in body.items():
            if key == 'extendedProperties':
                self.event['extendedProperties']['private'].update(value['private'])
            elif key == 'attendees' and body.get('attendeesOmitted'):
                for item in self.event['attendees']:
                    if item.get('self'):
                        item.update(value[0])
            else:
                self.event[key] = copy.deepcopy(value)
        self.event['etag'] = '"v2"'
        if self.lose_response:
            raise CalendarError('PERSONAL_CALENDAR_UNCERTAIN', 'Lost after commit')
        return copy.deepcopy(self.event)


def request(**changes):
    return {'action': 'update', 'calendarId': 'test', 'eventId': 'fixture', 'scope': 'event',
            'expectedEtag': '"v1"', 'marker': MARKER, 'fingerprint': FINGERPRINT,
            'patch': {'summary': 'Moved'}, **changes}


class CalendarMutationsTests(unittest.TestCase):
    def assert_code(self, code, request_value, native):
        with self.assertRaises(CalendarError) as context:
            operate(request_value, native)
        self.assertEqual(context.exception.code, code)

    def test_update_atomic_marker_and_preserve_creation_shared_properties(self):
        native = NativeFixture()
        result = operate(request(), native)
        self.assertTrue(result['mutationObserved'])
        self.assertEqual(result['event']['etag'], '"v2"')
        self.assertEqual(native.event['extendedProperties']['private']['agentxRequest'], 'creation-fingerprint')
        self.assertEqual(native.event['extendedProperties']['shared'], {'other': 'retained'})
        self.assertEqual(native.calls[-1][1]['sendUpdates'], 'none')
        self.assertEqual(native.calls[-1][3], {'If-Match': '"v1"'})
        self.assertNotIn('extendedProperties', result['event'])

    def test_lost_reply_is_reconciled_even_after_another_edit(self):
        native = NativeFixture()
        native.lose_response = True
        self.assert_code('PERSONAL_CALENDAR_UNCERTAIN', request(), native)
        native.event.update(summary='Later edit', etag='"v3"')
        replay = operate(request(reconcileOnly=True), native)
        self.assertTrue(replay['replayed'])
        self.assertEqual(replay['event']['summary'], 'Later edit')
        self.assertEqual(sum(method == 'events.patch' for method, *_ in native.calls), 1)

    def test_no_receipt_never_relaunches_even_when_etag_still_matches(self):
        native = NativeFixture()
        self.assert_code('PERSONAL_CALENDAR_UNCERTAIN', request(reconcileOnly=True), native)
        self.assertEqual([item[0] for item in native.calls], ['events.get'])

    def test_same_marker_changed_payload_refuses(self):
        native = NativeFixture()
        native.event['extendedProperties']['private'][MARKER] = 'c' * 64
        self.assert_code('PERSONAL_CALENDAR_ID_CONFLICT', request(), native)
        self.assertEqual(len(native.calls), 1)

    def test_stale_read_and_race_between_read_and_patch(self):
        native = NativeFixture()
        self.assert_code('PERSONAL_CALENDAR_CONFLICT', request(expectedEtag='"old"'), native)
        self.assertEqual(len(native.calls), 1)
        native.race = True
        self.assert_code('PERSONAL_CALENDAR_CONFLICT', request(), native)
        self.assertNotIn(MARKER, native.event['extendedProperties']['private'])
        self.assertEqual(native.event['summary'], 'Fixture')

    def test_scope_never_upgrades_instance_to_series_or_master_to_instance(self):
        native = NativeFixture()
        native.event['recurrence'] = ['RRULE:FREQ=WEEKLY;COUNT=3']
        self.assert_code('PERSONAL_CALENDAR_INVALID', request(), native)
        self.assert_code('PERSONAL_CALENDAR_INVALID', request(scope='occurrence', recurringEventId='fixture', originalStartTime={'date': '2030-01-01'}), native)
        operate(request(scope='series'), native)
        self.assertEqual(native.calls[-1][1]['eventId'], 'fixture')
        native = NativeFixture()
        native.event.update(recurringEventId='master', originalStartTime={'dateTime': '2030-11-03T10:00:00-05:00'})
        self.assert_code('PERSONAL_CALENDAR_INVALID', request(scope='series'), native)
        self.assert_code('PERSONAL_CALENDAR_INVALID', request(scope='occurrence', recurringEventId='wrong', originalStartTime={'dateTime': '2030-11-03T15:00:00Z'}), native)
        result = operate(request(scope='occurrence', recurringEventId='master', originalStartTime={'dateTime': '2030-11-03T15:00:00Z'}), native)
        self.assertEqual(result['event']['originalStartTime']['dateTime'], '2030-11-03T10:00:00-05:00')
        self.assertEqual(native.calls[-1][1]['eventId'], 'fixture')

    def test_cancel_exact_event_series_and_moved_all_day_occurrence(self):
        for scope in ['event', 'series', 'occurrence']:
            native = NativeFixture()
            identity = {}
            if scope == 'series':
                native.event['recurrence'] = ['RRULE:FREQ=DAILY']
            if scope == 'occurrence':
                native.event.update(recurringEventId='master', originalStartTime={'date': '2030-11-03'}, start={'date': '2030-11-05'})
                identity = {'recurringEventId': 'master', 'originalStartTime': {'date': '2030-11-03'}}
            value = request(action='cancel', scope=scope, patch={'status': 'cancelled'}, **identity)
            result = operate(value, native)
            self.assertEqual(result['event']['status'], 'cancelled')
            self.assertTrue(operate({**value, 'reconcileOnly': True}, native)['replayed'])
            # A provider tombstone without its marker cannot prove who cancelled it.
            native.event = {'id': 'fixture', 'status': 'cancelled'}
            self.assert_code('PERSONAL_CALENDAR_UNCERTAIN', {**value, 'reconcileOnly': True}, native)

    def test_existing_guests_require_exact_intent_and_complete_affected_recipients(self):
        native = NativeFixture()
        native.event['attendees'] = [{'email': 'guest@example.test', 'responseStatus': 'accepted'}]
        for authorization in [None, {'intent': 'cancel', 'recipients': ['guest@example.test']},
                              {'intent': 'update', 'recipients': ['wrong@example.test']}]:
            self.assert_code('PERSONAL_CALENDAR_GUEST_AUTHORIZATION_REQUIRED', request(authorization=authorization), native)
        self.assertEqual(sum(item[0] == 'events.patch' for item in native.calls), 0)
        operate(request(authorization={'intent': 'update', 'recipients': ['guest@example.test']}), native)
        self.assertEqual(native.calls[-1][1]['sendUpdates'], 'all')
        self.assertEqual(native.event['attendees'][0]['responseStatus'], 'accepted')

    def test_add_and_remove_attendees_preserves_other_rsvps_and_requires_removed_recipient(self):
        native = NativeFixture()
        native.event['attendees'] = [{'email': 'keep@example.test', 'responseStatus': 'accepted', 'optional': True}, {'email': 'remove@example.test'}]
        value = request(action='invite', patch={}, addAttendees=['added@example.test'], removeAttendees=['remove@example.test'])
        self.assert_code('PERSONAL_CALENDAR_GUEST_AUTHORIZATION_REQUIRED', {**value, 'authorization': {'intent': 'invite', 'recipients': ['keep@example.test', 'added@example.test']}}, native)
        value['authorization'] = {'intent': 'invite', 'recipients': ['keep@example.test', 'added@example.test', 'remove@example.test']}
        operate(value, native)
        self.assertEqual(native.event['attendees'], [{'email': 'keep@example.test', 'responseStatus': 'accepted', 'optional': True}, {'email': 'added@example.test'}])
        self.assertTrue(operate({**value, 'reconcileOnly': True}, native)['replayed'])
        self.assertEqual(sum(item[0] == 'events.patch' for item in native.calls), 1)

    def test_rsvp_only_changes_authenticated_attendee_and_targets_organizer(self):
        native = NativeFixture()
        native.event['organizer'] = {'email': 'organizer@example.test'}
        native.event['attendees'] = [{'email': 'owner@example.test', 'self': True, 'responseStatus': 'needsAction'},
                                     {'email': 'other@example.test', 'responseStatus': 'accepted'}]
        value = request(action='respond', patch={}, responseStatus='declined', authorization={'intent': 'respond', 'recipients': ['organizer@example.test', 'other@example.test']})
        operate(value, native)
        self.assertEqual(native.event['attendees'][0]['responseStatus'], 'declined')
        self.assertEqual(native.event['attendees'][1]['responseStatus'], 'accepted')
        sent = native.calls[-1][2]
        self.assertEqual(len(sent['attendees']), 1)
        self.assertTrue(sent['attendeesOmitted'])
        self.assertEqual(native.calls[-1][1]['sendUpdates'], 'all')

    def test_incomplete_guest_list_external_organizer_and_exhausted_markers_refuse(self):
        for change in [{'attendeesOmitted': True}, {'organizer': {'email': 'external@example.test'}},
                       {'extendedProperties': {'private': {str(i): 'v' for i in range(200)}}}]:
            native = NativeFixture()
            native.event.update(change)
            self.assert_code('PERSONAL_CALENDAR_INVALID', request(), native)
            self.assertEqual(len(native.calls), 1)


class ConditionalTransportTests(unittest.TestCase):
    @patch('calendar_conditional.cached_native_token', return_value='synthetic-token')
    @patch('calendar_conditional.build_opener')
    def test_fixed_host_encoded_identity_if_match_and_no_redirect_or_retry(self, opener, token):
        response = opener.return_value.open.return_value.__enter__.return_value
        response.read.return_value = b'{"id":"fixture"}'
        params = {'calendarId': 'fixture/@example.test', 'eventId': 'fixture', 'sendUpdates': 'none'}
        self.assertEqual(conditional_patch(params, {'summary': 'fixture'}, {'If-Match': '"v1"'}, {}, {}), {'id': 'fixture'})
        sent = opener.return_value.open.call_args.args[0]
        self.assertEqual(sent.method, 'PATCH')
        self.assertEqual(sent.headers['If-match'], '"v1"')
        self.assertIn('/fixture%2F%40example.test/', sent.full_url)
        self.assertEqual(opener.return_value.open.call_count, 1)
        for error, code in [(HTTPError(sent.full_url, 412, 'stale', {}, None), 'PERSONAL_CALENDAR_CONFLICT'),
                            (URLError('lost'), 'PERSONAL_CALENDAR_UNCERTAIN'),
                            (HTTPError(sent.full_url, 302, 'redirect', {}, None), 'PERSONAL_CALENDAR_UNCERTAIN')]:
            opener.return_value.open.side_effect = error
            with self.assertRaises(CalendarError) as context:
                conditional_patch(params, {}, {'If-Match': '"v1"'}, {}, {})
            self.assertEqual(context.exception.code, code)

    @patch('calendar_conditional.subprocess.run')
    def test_native_token_export_stays_anonymous_and_never_in_command_arguments(self, run):
        def native(args, **kwargs):
            if 'auth.list' in args[3]:
                return SimpleNamespace(returncode=0, stdout=json.dumps({'accounts': [{'email': 'owner@example.test', 'client': 'default'}]}))
            import os
            descriptor = kwargs['pass_fds'][0]
            self.assertIn('--out=/proc/self/fd/' + str(descriptor), args)
            os.write(descriptor, json.dumps({'access_token': 'fixture-secret', 'refresh_token': 'fixture-refresh',
                'access_token_expires_at': '2099-01-01T00:00:00Z'}).encode())
            return SimpleNamespace(returncode=0, stdout='{}')
        run.side_effect = native
        self.assertEqual(cached_native_token({'gogPath': '/fixture/gog', 'account': 'auto'}, {}), 'fixture-secret')
        self.assertNotIn('fixture-secret', str(run.call_args_list))
        self.assertNotIn('fixture-refresh', str(run.call_args_list))

    @patch('calendar_conditional.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='{"accounts":[]}'))
    def test_ambiguous_or_missing_native_auth_fails_without_write(self, _):
        with self.assertRaises(CalendarError) as context:
            cached_native_token({}, {})
        self.assertEqual(context.exception.code, 'PERSONAL_CALENDAR_AUTHORIZATION')

    @patch('calendar_conditional.cached_native_token', return_value='synthetic-token')
    @patch('calendar_conditional.build_opener')
    def test_google_403_quota_refusal_is_not_misreported_as_authorization(self, opener, _):
        import io
        body = io.BytesIO(b'{"error":{"errors":[{"reason":"rateLimitExceeded"}]}}')
        opener.return_value.open.side_effect = HTTPError('https://www.googleapis.com', 403, 'Forbidden', {}, body)
        with self.assertRaises(CalendarError) as context:
            conditional_patch({'calendarId': 'fixture', 'eventId': 'fixture', 'sendUpdates': 'none'}, {}, {'If-Match': '"v1"'}, {}, {})
        self.assertEqual(context.exception.code, 'PERSONAL_CALENDAR_RATE_LIMITED')
        self.assertEqual(opener.return_value.open.call_count, 1)
