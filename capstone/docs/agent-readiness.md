# Agent readiness

<!--
If an AI agent were given tools to operate this system, what would they be,
and what could go wrong (README §6, R-6.6)? This document is M3, 2 of the
manual points (GRADING.md §5). Keep the four ## headings as they are; the
stage 6 tests check that each has text of yours under it.

Write about this system, not about agents in general: generic
agent-security text scores 0.
-->

## Tools

<!--
3–5 tools an agent could use on this system. Keep the read tools apart from
the write tools. For each: its name, what it does, the endpoint it calls, and
its input schema (a small JSON Schema, or a TypeScript type).
-->

## Injection paths

<!--
Where could text that an attacker controls reach the agent? Name the fields,
in this system's messages, that carry free text from outside, and the tools
that would hand that text to the agent.
-->

## Controls

<!--
What stops the agent from doing damage: which tools need a human to
confirm, what is logged and where, what limits apply.
-->

## Not exposed

<!-- What you would never give an agent a tool for, and why. -->
