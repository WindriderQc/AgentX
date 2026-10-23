"""Conditional Calendar PATCH using gog's current native authorization.

The generic gog API CLI cannot set If-Match. Export its cached access token to
an anonymous Linux memory file on the credential host; never persist a second
auth store or transmit credentials to Core. Token refresh remains gog's job.
"""
from datetime import datetime, timezone
import json
import os
import re
import subprocess
from urllib.error import HTTPError, URLError
from urllib.parse import quote, urlencode
from urllib.request import Request, build_opener, HTTPRedirectHandler
from calendar_errors import CalendarError


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def cached_native_token(settings, env):
    args = [os.environ.get('GOOGLE_GOG_PATH') or settings.get('gogPath') or 'gog', '--json', '--no-input']
    account = os.environ.get('GOOGLE_ACCOUNT') or settings.get('account') or 'auto'
    try:
        listed = subprocess.run(args + ['--enable-commands-exact=auth.list', 'auth', 'list'],
                                env=env, capture_output=True, text=True, timeout=10)
        if listed.returncode:
            raise ValueError()
        accounts = json.loads(listed.stdout).get('accounts', [])
        matches = accounts if account == 'auto' else [item for item in accounts if item.get('email') == account]
        if len(matches) != 1:
            raise ValueError()
        selected = matches[0]
        # Linux memfd has no path on disk, including on crash. The child inherits only this descriptor.
        fd = os.memfd_create('agentx-calendar-auth', os.MFD_CLOEXEC)
        try:
            result = subprocess.run(args + ['--enable-commands-exact=auth.tokens.export',
                '--client=' + selected.get('client', 'default'), 'auth', 'tokens', 'export', selected['email'],
                '--out=/proc/self/fd/' + str(fd), '--overwrite'],
                env=env, pass_fds=(fd,), capture_output=True, text=True, timeout=10)
            if result.returncode:
                raise ValueError()
            os.lseek(fd, 0, os.SEEK_SET)
            token = json.loads(os.read(fd, 65536))
        finally:
            os.close(fd)
        expiry = datetime.fromisoformat(token.get('access_token_expires_at', '').replace('Z', '+00:00'))
        if (expiry - datetime.now(timezone.utc)).total_seconds() < 30 or not token.get('access_token'):
            raise ValueError()
        return token['access_token']
    except (OSError, ValueError, KeyError, TypeError, AttributeError, subprocess.TimeoutExpired):
        raise CalendarError('PERSONAL_CALENDAR_AUTHORIZATION', 'Native Google authorization unavailable; no conditional write sent.') from None


def conditional_patch(params, body, headers, settings, env):
    if set(headers) != {'If-Match'} or not re.fullmatch(r'"[^"\r\n]{1,200}"', headers['If-Match']):
        raise CalendarError('PERSONAL_CALENDAR_INVALID', 'A quoted Google ETag is required.')
    if set(params) != {'calendarId', 'eventId', 'sendUpdates'} or params['sendUpdates'] not in {'none', 'all'}:
        raise CalendarError('PERSONAL_CALENDAR_INVALID', 'Invalid conditional Calendar parameters.')
    token = cached_native_token(settings, env)
    url = 'https://www.googleapis.com/calendar/v3/calendars/' + quote(params['calendarId'], safe='') + '/events/' + quote(params['eventId'], safe='')
    url += '?' + urlencode({'sendUpdates': params['sendUpdates']})
    request = Request(url, method='PATCH', data=json.dumps(body).encode(), headers={
        'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json', **headers})
    try:
        # No redirects or automatic retries for a possibly executed mutation.
        with build_opener(NoRedirect).open(request, timeout=25) as response:
            raw = response.read(512 * 1024 + 1)
            if len(raw) > 512 * 1024:
                raise ValueError()
            return json.loads(raw)
    except HTTPError as error:
        # Google uses 403 for quota refusals as well as access denial. Keep the
        # proven pre-write refusal distinct from invalid authorization.
        reasons = set()
        try:
            data = json.loads(error.read(65536))
            reasons = {item.get('reason') for item in data.get('error', {}).get('errors', [])}
        except (ValueError, AttributeError, TypeError):
            pass
        finally:
            error.close()
        if error.code == 429 or (error.code == 403 and reasons & {
                'rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded', 'calendarUsageLimitsExceeded'}):
            raise CalendarError('PERSONAL_CALENDAR_RATE_LIMITED', 'Google refused this write before execution due to a rate limit.') from None
        codes = {412: 'PERSONAL_CALENDAR_CONFLICT', 404: 'PERSONAL_CALENDAR_NOT_FOUND',
                 410: 'PERSONAL_CALENDAR_NOT_FOUND', 401: 'PERSONAL_CALENDAR_AUTHORIZATION',
                 403: 'PERSONAL_CALENDAR_AUTHORIZATION', 400: 'PERSONAL_CALENDAR_INVALID'}
        raise CalendarError(codes.get(error.code, 'PERSONAL_CALENDAR_UNCERTAIN'), 'Conditional Calendar write failed; retain the same requestId.') from None
    except (URLError, TimeoutError, OSError, ValueError):
        raise CalendarError('PERSONAL_CALENDAR_UNCERTAIN', 'Conditional Calendar outcome uncertain; reconcile the same requestId.') from None
