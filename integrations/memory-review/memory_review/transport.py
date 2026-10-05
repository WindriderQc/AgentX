"""Private LAN HTTP transport with normal TLS verification and no redirects."""

from urllib.request import HTTPRedirectHandler, build_opener


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Do not forward observations to a redirected URL.
        return None


def urlopen(request, *, timeout):
    return build_opener(_NoRedirect()).open(request, timeout=timeout)
