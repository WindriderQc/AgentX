"""Google-native edits with explicit scope, guest intent and atomic receipt markers."""
from datetime import datetime
import re
from calendar_errors import CalendarError


def refuse(message, code='PERSONAL_CALENDAR_INVALID'):
    raise CalendarError(code, message)


def same_start(left, right):
    if 'date' in left or 'date' in right:
        return left.get('date') == right.get('date') and bool(left.get('date'))
    try:
        return datetime.fromisoformat(left['dateTime'].replace('Z', '+00:00')) == datetime.fromisoformat(right['dateTime'].replace('Z', '+00:00'))
    except (KeyError, ValueError):
        return False


def mutate(request, call, project):
    params = {'calendarId': request['calendarId'], 'eventId': request['eventId']}
    event = call('events.get', params)
    private = event.get('extendedProperties', {}).get('private', {})
    marker, fingerprint = request.get('marker', ''), request.get('fingerprint', '')
    if not re.fullmatch(r'axm[0-9a-f]{32}', marker) or not re.fullmatch(r'[0-9a-f]{64}', fingerprint):
        refuse('Invalid operation receipt identity.')
    if marker in private:
        if private[marker] != fingerprint:
            refuse('Operation marker belongs to another payload.', 'PERSONAL_CALENDAR_ID_CONFLICT')
        return {'event': project(event), 'replayed': True, 'mutationObserved': True, 'eventObservation': 'current_read'}
    if request.get('reconcileOnly'):
        refuse('No native receipt observed. Do not dispatch again or replace the requestId.', 'PERSONAL_CALENDAR_UNCERTAIN')
    if event.get('etag') != request.get('expectedEtag'):
        refuse('Event changed. Read it again and review a new intent.', 'PERSONAL_CALENDAR_CONFLICT')
    scope = request.get('scope')
    if scope == 'event':
        if event.get('recurringEventId') or event.get('recurrence'):
            refuse('Recurring events require explicit occurrence or series scope.')
    elif scope == 'series':
        if event.get('recurringEventId') or not event.get('recurrence'):
            refuse('Series scope requires the master event ID and its own ETag.')
    elif scope == 'occurrence':
        if not event.get('recurringEventId') or event['recurringEventId'] != request.get('recurringEventId') or not same_start(event.get('originalStartTime', {}), request.get('originalStartTime', {})):
            refuse('Occurrence identity does not match Google.')
    else:
        refuse('Explicit scope is required.')
    if event.get('status') == 'cancelled':
        refuse('The event is cancelled; it cannot be recreated by mutation.', 'PERSONAL_CALENDAR_CANCELLED')
    action = request['action']
    patch = dict(request.get('patch', {}))
    attendees = event.get('attendees', [])
    if event.get('attendeesOmitted'):
        refuse('Incomplete guest list: cannot authorize affected recipients.')
    organizer = event.get('organizer', {})
    if action != 'respond' and organizer and not organizer.get('self'):
        refuse('Only the organizer can change this event; respond to your invitation instead.')
    if action == 'invite':
        added, removed = set(request.get('addAttendees', [])), set(request.get('removeAttendees', []))
        if not added and not removed or added & removed:
            refuse('Explicit, disjoint attendee changes are required.')
        by_email = {item['email'].lower(): item for item in attendees}
        if not removed <= by_email.keys() or added & by_email.keys():
            refuse('Guest list changed or attendee change is a no-op.')
        if any(by_email[email].get('self') or by_email[email].get('organizer') for email in removed):
            refuse('Cannot remove the organizer or yourself as an attendee.')
        patch['attendees'] = [item for item in attendees if item['email'].lower() not in removed] + [{'email': email} for email in sorted(added)]
        if len(patch['attendees']) > 50:
            refuse('Guest limit exceeded.')
    if action == 'respond':
        own = [item for item in attendees if item.get('self')]
        if len(own) != 1 or own[0].get('organizer') or organizer.get('self') or not organizer.get('email'):
            refuse('This event is not an invitation to the authenticated account.')
        if request.get('responseStatus') not in {'accepted', 'tentative', 'declined'}:
            refuse('Invalid invitation response.')
        # Google's partial RSVP contract changes only the authenticated attendee.
        patch.update(attendees=[{**own[0], 'responseStatus': request['responseStatus']}], attendeesOmitted=True)
        affected = {organizer['email'].lower()} | {item['email'].lower() for item in attendees if not item.get('self')}
    else:
        affected = {item['email'].lower() for item in attendees + patch.get('attendees', []) if not item.get('self') and not item.get('organizer')}
    authorization = request.get('authorization') or {}
    if affected:
        if authorization.get('intent') != action or set(authorization.get('recipients', [])) != affected:
            refuse('Explicit intent and the exact affected recipients are required.', 'PERSONAL_CALENDAR_GUEST_AUTHORIZATION_REQUIRED')
    elif authorization:
        refuse('Authorization recipients do not match this event.', 'PERSONAL_CALENDAR_GUEST_AUTHORIZATION_REQUIRED')
    if action not in {'update', 'cancel', 'invite', 'respond'}:
        refuse('Unsupported mutation.')
    if len(private) >= 200:
        refuse('Native receipt property capacity reached; retain existing receipts.')
    patch['extendedProperties'] = {'private': {**private, marker: fingerprint}}
    # Receipt and domain change commit in the same conditional Google write.
    event = call('events.patch', {**params, 'sendUpdates': 'all' if affected else 'none'}, patch,
                 {'If-Match': request['expectedEtag']})
    if event.get('id') != params['eventId'] or event.get('extendedProperties', {}).get('private', {}).get(marker) != fingerprint:
        refuse('Google returned no matching operation receipt.', 'PERSONAL_CALENDAR_UNCERTAIN')
    return {'event': project(event), 'replayed': False, 'mutationObserved': True, 'eventObservation': 'write_result',
            'guestUpdates': 'requested' if affected else 'none', 'notificationDelivery': 'Google Calendar; delivery not verified'}
