"""Qualification fixture #681 v2: next-ticket selection order for synthetic queues.

Selects the tickets that are ready to be picked up (queued, authorized, low
risk, dependencies done) and orders them for the dispatcher: lower priority
value first, ties broken lexicographically by id. The input and its records
are never mutated.
"""


def ready_ticket_ids(records):
    """Return ids of ready records sorted by increasing priority, then id.

    Each record is a dict with string ``id``, ``state``, ``authorized``,
    ``risk``, ``dependenciesDone`` and integer ``priority`` (1 to 5).
    A record is ready when its state is ``"queued"``, ``authorized`` is
    ``True``, ``risk`` is ``"low"`` and ``dependenciesDone`` is ``True``.
    """
    ready = [
        (record["priority"], record["id"])
        for record in records
        if record["state"] == "queued"
        and record["authorized"] is True
        and record["risk"] == "low"
        and record["dependenciesDone"] is True
    ]
    return [ticket_id for _, ticket_id in sorted(ready)]
