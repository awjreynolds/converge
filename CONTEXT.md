# Converge

Converge is a pair-programming and comprehension harness that keeps an engineer aligned with software being implemented by an AI coding agent.

## Language

**Pairing Session**:
The complete Converge-guided implementation journey from a task or specification through verified code and confirmed shared understanding.
_Avoid_: Chat, run, review session

**Change Unit**:
One meaningful engineering decision presented with the intent, rationale, evidence, resulting code, and human response needed to understand its place in a Pairing Session.
_Avoid_: Patch, commit, file change, approval request

**Reasoning Panel**:
The Converge client surface where an engineer follows and responds to Change Units during implementation.
_Avoid_: Chat panel, review panel

**Discuss**:
A response that asks for clarification or explores a proposed Change Unit without yet accepting or redirecting it.
_Avoid_: Comment, review

**Redirect**:
A response that supplies corrective direction and requires a proposed Change Unit to be revised while preserving its causal history.
_Avoid_: Reject, edit request

**Understanding Check**:
The final alignment step that compares the engineer's mental model, the agent's account, and the implemented system before a Pairing Session is complete.
_Avoid_: Quiz, review approval
