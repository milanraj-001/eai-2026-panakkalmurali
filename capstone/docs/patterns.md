# Patterns

<!--
The integration patterns in your system, and where they are (README §6, R-6.3).

What the stage 6 tests check: a table with the columns Pattern | Problem |
Where | Why, at least 8 rows, a Normalizer row among them, and every Where
link resolving to a file and a line that exist in your repository.

What is judged (GRADING.md §5, M4): every row must be true at its link. A row
that claims something your code does not do is a false row. One false row
costs M4's point; more than one also costs up to 3 more points of the manual
block. Eight true rows beat twelve rows with two wrong ones. At the defence I
pick a row and you show me the code behind it.

Where: link the line where the pattern happens, not the file's first line.
Either form works:

    [normalize.ts:42](../intake/src/normalize.ts#L42)    a link, resolved from docs/
    intake/src/normalize.ts:42                           a bare path, from capstone/

A pattern in two places can have two links. After you change the code,
check that the lines still point where you mean.

The course's patterns include: Normalizer, Message Translator, Content
Enricher, Content Filter, Canonical Data Model, Content-Based Router,
Idempotent Receiver, Guaranteed Delivery, Dead Letter Channel, Invalid
Message Channel, Retry with a delay queue, Correlation Identifier, Wire Tap,
Message Store, Process Manager / Saga, Compensating Transaction, Semantic
Lock, Competing Consumers. List only the ones your code really has.

Problem: what goes wrong without the pattern, in this system. Why: why this
pattern and not another. One sentence each is enough.
-->

| Pattern | Problem | Where | Why |
|---|---|---|---|
