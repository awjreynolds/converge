# Prevent revoked sessions from refreshing

A revoked session must not be able to issue a new refresh token.

Preserve the existing `SessionLookup` persistence seam. Add a failing behavioural test first, then implement the smallest change that makes it pass.

The final explanation should make clear:

- where revocation is enforced;
- whether the public interface changed;
- which persistence seam is retained;
- what the verification established.
