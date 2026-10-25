#!/bin/sh
# Forced-command entry for the Core actuator key (authorized_keys command=).
# It passes the client's command, as one argument, to the actuator under sudo.
# The actuator parses it against its closed grammar and refuses anything else.
exec sudo -n /usr/local/sbin/agentx-topology-actuator ssh -- "${SSH_ORIGINAL_COMMAND:-}"
