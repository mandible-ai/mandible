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
survive a restart, so something has to say the work is done. Two answers, and
the first is usually the right one.

**Let a label carry it.** Sense the request rather than every open pull
request, and consume the request when you serve it:

```ts
.sense(['pr:open', 'pr:review-requested'], { unclaimed: true, tags: ['pr:needs-review'] })
.do('review', async (signal, ctx) => {
  // ... post the review ...
  const tags = (signal.meta?.tags ?? []).filter(t => t !== 'pr:needs-review');
  await ctx.enrich(signal.id, { tags: [...tags, 'pr:reviewed'] });
});
```

The pull request stops being sensed because the mark changed, not because the
colony remembered anything. The state lives in one place, where a human can see
it and change it: label it again to ask for another pass. Labels are written as
a whole set, so carry the others over.

**Or read what the signal already knows.** With `fetchReviews` enabled the
payload carries a review summary, including the commit the latest review was
written against:

```ts
const { reviews, head } = signal.payload as {
  reviews?: { reviewState: string; latestReview?: { user: string; revision?: string } };
  head?: { sha?: string };
};
if (reviews?.latestReview?.user === ME && reviews.latestReview.revision === head?.sha) return;
```

That is already in the signal, so it costs no request. `listReviews` is still
there for the full history, but reaching for it to answer "have I done this"
means keeping the answer somewhere the environment cannot see.

Beware the third answer: writing a marker into the review body and grepping it
back. It works, and it is bookkeeping the colony keeps about itself in a
private format, which is the thing stigmergy exists to avoid.

## Do not deposit a completion signal

`ctx.deposit('review:complete')` is the intention-revealing call, and on GitHub
it is the wrong one: `deposit` opens an issue, so it would file one on every
review.

That is not a flaw in the mapping. A deposit into a repository is **a new work
item**, and an issue is exactly that. `bug:found` deposits correctly, because
someone now has to fix it. A completion trace is not a work item.

On a forge the artifact you produce is the trace. Post the review and the review
is the mark: durable, public, and carried back in the pull request's payload on
the next poll, where any colony can see the change has been reviewed and in what
state. A second signal saying so would duplicate it, as an issue.

Two conditions on that, both easy to miss. The payload only carries reviews when
the environment is built with `fetchReviews` (the default). And the trace is in
the payload, not the signal *type*: `defaultPRTypeMapper` moves a pull request
to `pr:approved` or `pr:changes-requested`, but a `comment` review — the verdict
this guide recommends — leaves the type alone, deliberately, because displacing
`pr:open` would hide the pull request from every reviewer colony the moment
anyone commented. `reviewState` reports `commented` for it. So a sensor cannot
filter on "has been reviewed"; a label can, which is the section above.

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
