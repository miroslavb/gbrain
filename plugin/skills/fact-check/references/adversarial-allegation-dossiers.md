# Reviewing accusatory dossiers and evidentiary packets

Use this reference when a PDF, website, or evidence bundle alleges that a named person committed fraud, evaded a debt, harassed someone, concealed assets, or engaged in another civil or criminal wrong. The goal is a defensible assessment of what the supplied artifacts establish, not a competing accusation.

## Procedure

### 1. Set the boundary before retrieval

- State that the document is an allegation package, not a judgment or independent finding.
- Keep private uploads in the document-scoped retrieval path. Do not copy sensitive accusations into shared memory, Git, or a public report merely because they are readable.
- Decide what is unnecessary. Avoid discovering home addresses, immigration details, family data, or contact information when the question can be answered from already supplied material and non-sensitive public records.
- Preserve the original file hash and identify the extraction method. Treat OCR text, page prose, screenshots, and linked originals as different evidence layers.

### 2. Build a claim-to-artifact ledger

For every load-bearing allegation, record:

1. the exact allegation;
2. the legal or factual element it depends on;
3. the artifact offered in support;
4. the strongest proposition that artifact actually proves;
5. what remains unproved;
6. the independent source needed to close the gap.

Use statuses such as `established by artifact`, `corroborated externally`, `consistent but non-probative`, `unverified`, `contradicted`, and `requires original`. Do not collapse “artifact exists” into “allegation proved.”

### 3. Inspect visual evidence independently of captions

Read the underlying screenshot or scan, not the dossier author’s caption. Transcribe the exact status language, date, amount, account role, and any conditional wording. Mask full account numbers and private addresses in notes and output.

For bank evidence, model the transaction as a state machine:

`created/requested → scheduled/submitted → processed → delivered → accepted/cleared → funds irreversibly credited`

Assign only the state explicitly shown. In particular:

- `payment submitted`, `scheduled`, `estimated delivery`, or `transfer request` does not establish clearing or receipt;
- a warning that a check *may* be cashed does not establish that it was;
- separate screenshots are not automatically separate completed transfers;
- never add a check amount, an attempted transfer, and a completed transfer unless unique transaction identifiers and settlement records prove they are distinct;
- if dates differ, test whether one is creation date and another is execution date before calling the record inconsistent.

Request or identify the closing evidence: statement debit, canceled-check image, ACH trace, receiving-account credit, reversal/cancellation record, or bank confirmation tied to the same transaction.

### 4. Separate contract formation, breach, and fraud

A request for money, a transfer, a later demand, and nonpayment are different propositions. Check separately for:

- parties and capacity;
- loan versus investment versus gift;
- principal amount actually delivered;
- maturity or repayment trigger;
- interest and other terms;
- acknowledgment by the alleged obligor;
- breach date and demand history;
- reliance, misrepresentation, and contemporaneous intent for fraud.

Do not infer fraudulent intent solely from later nonpayment, silence, wealth, or an unsuccessful business transaction. Do not say the agreement lacks a term merely because the selected excerpts omit it; say the supplied excerpts do not show it.

### 5. Check registries by the field’s defined semantics

Prefer the official register and read its field definitions. A registry row usually proves only the recorded relationship and status as of a date.

- `Power units` may include owned, term-leased, and trip-leased equipment; it is not a count of personally owned, debt-free assets.
- Company officer, registered agent, director, mailing address, and beneficial owner are distinct roles.
- An active corporate filing, active transport identifier, and operating authority are separate status dimensions.
- An inactive carrier record does not by itself prove corporate dissolution.
- Gross purchase price is not current equity, liquidity, or source of funds.
- Shared addresses and overlapping officers show association, not tracing of disputed money.

When official access is blocked, label derivative registries as secondary and record their update date. Do not turn absence from a stale secondary record into a contradiction.

### 6. Verify dynamic pages as changing records

For fundraising pages, profiles, and other editable pages:

- capture the current title, organizer, beneficiary, goal, creation date, story text, URL, and retrieval timestamp;
- distinguish page metadata from assertions inside the story;
- compare current fields to the dossier without assuming either version is immutable;
- if organizer metadata and story text name different people, report the mismatch and the possibility of a later edit rather than declaring fraud;
- matching round amounts or shared surnames are leads, not proof of deception or misuse.

Use a real browser when the rendered state matters, then save a compact text/JSON evidence receipt so the exact current wording survives context compaction.

### 7. Authenticate procedural claims

A document labeled `filed`, `served`, `official`, or `vector PDF` is not authenticated by its caption or file format. Look for:

- court or agency name;
- case, docket, or agency receipt number;
- filing stamp and timestamp;
- service return or delivery evidence;
- named signatory and capacity;
- clerk or agency acknowledgment;
- independently retrievable docket entry or order.

Distinguish a private demand letter, an agency submission, an opened matter, a filed case, and an adjudicated judgment. Never use one label for all five.

### 8. Test legal propositions against the exact provision

Open the primary statute or rule and verify subsection, version, and operative words. Then separate:

- cause-of-action elements;
- remedy or interest after judgment;
- procedural prerequisites;
- limitation period;
- accrual date;
- tolling or revival;
- jurisdiction and venue.

Do not apply a statutory judgment-interest rate to a pre-judgment private debt merely because a demand letter cites it. For limitations, identify whether the obligation is founded on a written instrument and when the claim accrued; the transfer date alone may not be the breach date when maturity or repayment trigger is unclear. Present this as an issue for counsel unless the necessary contract and procedural facts are established.

### 9. Audit reasoning bridges and arithmetic

Recompute totals with a tool. Inventory enumerated items and compare them with headline counts. Treat a mismatch as a methodology gap unless it changes the substantive result.

Challenge common invalid bridges:

- asset → ability to pay;
- ability to pay → deliberate refusal;
- refusal → fraud at inception;
- business affiliation → personal ownership;
- detention → guilt of the dossier’s financial allegation;
- repeated crude messages → every statutory element of harassment or stalking;
- demand sent → debt adjudicated;
- public record → permission to republish unnecessary private details.

### 10. Report by evidentiary strength

Lead with a short conclusion, then organize findings as:

- **Corroborated facts** — supported by the supplied artifact and an appropriate independent source;
- **Supported only to a narrower proposition** — artifact is real or consistent, but proves less than claimed;
- **Material gaps** — missing settlement, identity, contract, tracing, service, docket, or intent evidence;
- **Contradictions or date/status mismatches** — explain whether they may reflect different record dates or transaction states;
- **Legal issues requiring counsel** — elements, accrual, limitations, collectability, entity separation, and remedies;
- **Next evidence to obtain** — the smallest primary record that would resolve each major gap.

Use attribution throughout: “the dossier alleges,” “the screenshot shows,” “the registry records,” and “the supplied material does not establish.” Avoid declaring a person a fraudster, debtor, harasser, or criminal unless an appropriate authoritative adjudication supports that exact proposition.

## Minimum quality gate

Before delivery, confirm that:

- every central allegation has a claim-to-artifact row;
- each screenshot was read independently of its caption;
- amounts were not double-counted across transaction states;
- registry field definitions were checked;
- dynamic pages carry a retrieval timestamp;
- procedural labels were not promoted to court outcomes;
- legal citations were opened at the exact subsection;
- unnecessary private data was excluded;
- the conclusion distinguishes nonpayment, breach, collectability, and fraudulent intent;
- limitations and missing originals are stated as uncertainties, not guessed away.
