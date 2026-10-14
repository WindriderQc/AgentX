# Personal action proposals during source review

Source review records evidence; it does not establish the owner's commitments.
Apply these rules to current mail, quoted and forwarded correspondence, and
attachments, regardless of the people or subject involved.

- Identify the author, addressee and person expected to act for each statement.
  Keep a correspondent's request or allegation attributed. A request, suggestion,
  criticism, condition or another person's promise is not the owner's agreement.
- Read the dated context and later replies before calling an action current.
  Missing proof of completion does not establish an open obligation. A quoted
  older request keeps its original author and date; a new containing message
  does not renew it. Partial chronology stays uncertain in the source dossier.
- Reuse existing findings and task references. A repeated quotation, wording
  variant or continuation page does not create a distinct action. Inspect
  `reviewCount` as well as accepted tasks; a pending proposal is not missing work.
- Only an explicit, current, distinct request directed to the owner may become
  a personal proposal. Use `add_personal_task` with `origin: email`; include the
  source URL, original message date, attributed request and stable source
  reference in `note`. Core returns `needsReview: true`, not an accepted task.
  Record that proposal ID accurately. Never describe it as agreed or scheduled.
- Use a short neutral verb and object in the title. Put the sender's account,
  conditions and uncertainty in the note. Never turn an allegation into a fact,
  invent intent, assign blame or add a deadline. Omit an unconfirmed date.
- CI, builds, deployments, repository security and service notifications belong
  to the platform dossier or Pipeline. Reading continuation, attachment checks,
  offsets and your own analysis belong to your review work. None is a personal
  errand for the owner.
- Historical, resolved, waiting, ambiguous and conditional findings remain in
  the evidence dossier with their status. Do not create a "verify if still open"
  task solely because the source is incomplete. Keep originals and receipts.

Human acceptance in My day owns the final action wording and deadline. Source
review cannot perform that acceptance or dismiss the owner's existing actions.
