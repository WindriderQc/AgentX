"""Invented correspondence shared by both remaining #754 consumers."""
A = "Person A <a@example.invalid>"
B = "Person B <b@example.invalid>"
CAMP = "Please bring the green backpack for camp on Monday."
INVOICES = "Could you organize the household invoices before Friday?"
JULY = "Thu, 16 Jul 2026 20:00:00 +0000"
OCTOBER = "Sun, 11 Oct 2026 12:00:00 +0000"
GMAIL = "On Thu, Jul 16, 2026 at 8:00 PM " + A + " wrote:\n"
WRAPPED = "Le jeu. 16 juil. 2026 à 20 h 00, " + A + "\n a\n écrit :\n"
OUTLOOK = "-----Original Message-----\nFrom: " + A + "\nSent: July 16, 2026 8:00 PM\nTo: " + B + "\nSubject: Camp\n\n"


def quoted(text, level=1):
    return "".join(">" * level + " " + line + "\n" for line in text.splitlines())


def cases():
    """name, full original body, retained quotation, claimed author, relation."""
    for request in (CAMP, INVOICES):
        for name, header in (("gmail", GMAIL), ("wrapped-gmail", WRAPPED), ("outlook", OUTLOOK)):
            yield name + request[:6], "October reply.\n" + header + quoted(request), request, A, "quoted"
    yield "continuation", "October reply.\n" + GMAIL + quoted("Padding without a claim.\n" * 150 + CAMP), CAMP, A, "quoted"
    yield "nested", ("Outer reply.\n" + GMAIL.replace(A, B) + "> Before nesting.\n"
                     + quoted(GMAIL.strip()) + quoted(INVOICES, 2)), INVOICES, A, "quoted"
    yield "resumed", ("Outer reply.\n" + GMAIL.replace(A, B) + "> Before nesting.\n"
                      + quoted(GMAIL.strip()) + quoted(INVOICES, 2) + "> Outer text resumes.\n"), "Outer text resumes.", None, "unresolved"
    yield "ambiguous", "Reply.\nOn Thursday, Person A wrote:\n" + quoted(CAMP), CAMP, None, "quoted"
    yield "partial", "Reply.\nOn July 16, 2026, Person A\n" + CAMP, CAMP, None, "quoted"
    yield "conflicting-outlook", "Reply.\n" + OUTLOOK.replace("To:", "From: Person C\nTo:") + INVOICES, INVOICES, None, "quoted"
