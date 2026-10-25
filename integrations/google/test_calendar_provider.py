import unittest
from unittest.mock import patch
from types import SimpleNamespace
from calendar_provider import CalendarError, operate, gog_call


class CalendarProviderTests(unittest.TestCase):
    def test_insert_recovery_and_conflict(self):
        store = {}
        calls = []
        def call(method, params, body=None):
            calls.append(method)
            if method == 'events.get':
                if params['eventId'] not in store:
                    raise CalendarError('PERSONAL_CALENDAR_NOT_FOUND', 'missing')
                return store[params['eventId']]
            store[body['id']] = body
            return body
        request = {'action': 'create', 'eventId': 'abc123', 'fingerprint': 'same',
                   'body': {'summary': 'Synthetic', 'extendedProperties': {'private': {'agentxRequest': 'same'}}}}
        self.assertFalse(operate(request, call)['replayed'])
        self.assertTrue(operate(request, call)['replayed'])
        self.assertEqual(calls.count('events.insert'), 1)
        with self.assertRaises(CalendarError) as error:
            operate({**request, 'fingerprint': 'changed'}, call)
        self.assertEqual(error.exception.code, 'PERSONAL_CALENDAR_ID_CONFLICT')

    def test_uncertain_insert_is_never_replaced(self):
        calls = []
        def call(method, params, body=None):
            calls.append(method)
            raise CalendarError('PERSONAL_CALENDAR_NOT_FOUND' if method == 'events.get' else 'PERSONAL_CALENDAR_UNCERTAIN', 'failed')
        with self.assertRaises(CalendarError) as error:
            operate({'action': 'create', 'eventId': 'abc123', 'body': {}, 'fingerprint': 'same'}, call)
        self.assertEqual(error.exception.code, 'PERSONAL_CALENDAR_UNCERTAIN')
        self.assertEqual(calls, ['events.get', 'events.insert'])

    def test_duplicate_insert_reconciles_and_cancelled_event_stays_cancelled(self):
        event = {'id': 'abc123', 'status': 'cancelled', 'extendedProperties': {'private': {'agentxRequest': 'same'}}}
        count = 0
        def call(method, params, body=None):
            nonlocal count
            count += 1
            if count == 1:
                raise CalendarError('PERSONAL_CALENDAR_NOT_FOUND', 'missing')
            if method == 'events.insert':
                raise CalendarError('PERSONAL_CALENDAR_EXISTS', 'race')
            return event
        with self.assertRaises(CalendarError) as error:
            operate({'action': 'create', 'eventId': 'abc123', 'body': {}, 'fingerprint': 'same'}, call)
        self.assertEqual(error.exception.code, 'PERSONAL_CALENDAR_CANCELLED')

    @patch('calendar_provider.native_settings', return_value={'gogPath': '/fixture/gog'})
    @patch('calendar_provider.Path.read_text', return_value='synthetic-keyring')
    @patch('calendar_provider.subprocess.run', return_value=SimpleNamespace(returncode=0, stdout='{"id":"abc123"}', stderr=''))
    def test_fixed_method_policy_and_body_stdin(self, run, *_):
        gog_call('events.insert', {'calendarId': 'primary'}, {'summary': 'Synthetic'})
        args = run.call_args.args[0]
        self.assertIn('--enable-commands-exact=api.call,api.calendar.events.insert', args)
        self.assertIn('--body=@/dev/stdin', args)
        self.assertNotIn('synthetic-keyring', ' '.join(args))
        self.assertEqual(run.call_args.kwargs['input'], '{"summary": "Synthetic"}')
        with self.assertRaises(CalendarError):
            gog_call('gmail.messages.send', {})


if __name__ == '__main__':
    unittest.main()
