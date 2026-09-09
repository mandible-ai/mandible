# Review pull requests

A colony can read a proposed change and answer it with a review, without
knowing which API to call. `CodeReviewable` is the capability that makes that
possible; `GitHubEnvironment` implements it.

## Why a capability and not part of `Environment`

Signals say *that* a change exists. A review needs the change itself and a way
back to it, and most substrates have neither: a filesystem has no notion of a
review, and putting one on `Environment` would mean a method that always
throws. So it is an interface an environment may implement, and a type guard
that narrows to it.

```ts
import { isCodeReviewable } from '@mandible-ai/mandible';

.do('review', async (signal, ctx) => {
  const substrate = ctx.environment;
  if (!isCodeReviewable(substrate)) {
    throw new Error(`${substrate.name} cannot carry a review`);
  }

  const diff = await substrate.fetchDiff(signal.id);
  const body = await yourModelCall(diff);
  await substrate.submitReview(signal.id, { verdict: 'comment', body });
});
```

`ctx.environment` is the substrate the colony is acting in. Most actions never
need it — `deposit`, `withdraw` and `enrich` are the substrate-neutral verbs.

## Not reviewing the same commit twice

A sensor re-senses an open pull request on every poll, and claims do not
survive a restart, so a reviewer must decide for itself whether it has already
done the work. `listReviews` reports the revision each review was written
against, which answers it exactly:

```ts
const reviews = await substrate.listReviews(signal.id);
const head = (signal.payload as { head?: { sha?: string } }).head?.sha;
if (reviews.some(r => r.author === ME && r.revision === head)) return;
```

A new push moves the head, so the next poll reviews the new code and only the
new code.

## Do not deposit a completion signal

`ctx.deposit('review:complete')` is the intention-revealing call, and on GitHub
it is the wrong one: `deposit` opens an issue, so it would file one on every
review.

That is not a flaw in the mapping. A deposit into a repository is **a new work
item**, and an issue is exactly that. `bug:found` deposits correctly, because
someone now has to fix it. A completion trace is not a work item.

On a forge the artifact you produce is the trace. Post the review and the review
is the mark: durable, public, and sensed back into the pull request's payload on
the next poll, where any colony can see the change has been reviewed and in what
state. A second signal saying so would duplicate it, as an issue.

So a reviewer colony deposits when it finds something that outlives the pull
request — a defect in code the diff only touched in passing, which will still be
there after the merge — and stays quiet otherwise. Problems *within* the change
belong in the review, where the author is already looking.

## Verdicts

`comment`, `approve` and `request-changes` are the vocabulary. GitHub maps them
onto `COMMENT`, `APPROVE` and `REQUEST_CHANGES`.

Reading reviews back can also yield `other`, for a verdict the substrate has
and this vocabulary does not — a dismissed or pending GitHub review. Calling
one of those a comment would misreport what a person decided.

An automated reviewer should almost always submit `comment`. Approving or
requesting changes casts a vote that gates a merge, which is a decision a
colony should not be making on someone's behalf.

## Running read-only

`allowReview: false` on the GitHub environment makes `submitReview` throw
instead of posting. Useful for pointing a reviewer at a repository and reading
its output from the logs before letting it speak.
