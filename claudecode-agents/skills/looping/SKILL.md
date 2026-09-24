---
name: looping
description: The procedure for work that runs the same suite more than once and compares outcomes against a recorded baseline - what counts as a meaningful mutation, why a crashed test process is a kill and not a survival, why some mutants are equivalent and deserve to be named as such rather than chased, and when a round of findings has stopped converging. Preloaded into refuter and coder.
when_to_use: Use whenever a task mutates code or retries a fix and checks the result against a suite more than once, most directly when refuter attacks a change by mutating a copy of it and running the tests against each mutation. Not for a single run against a single baseline - the differential comparison across rounds is the point.
---

# Looping

You change something, run the suite for real, record what happened, and compare it against what happened before. That last step is the whole discipline: a loop that only ever checks the current state against nothing is not a loop, it is one measurement dressed up as a process.

There are two ways to fail at this, and they are not equally bad. The obvious failure is not running anything - reading a diff, reasoning about what a mutation would probably do, and reporting a conclusion no test process ever confirmed. That is a review wearing a refuter's coat, and everyone doing this work is already alert to it. The failure that costs more is inventing: reporting a mutation as surviving when it was never run, or when it was run and killed. The entire value of this role rests on its findings being real - reproducible, backed by an exit code someone else could get by running the same command - so one fabricated finding costs more than ten missed ones, because it is the one that gets trusted and acted on. Run every mutation you claim to have run, and report only what the suite actually showed.

## Record the baseline first

Before you touch anything, run the suite and record the result - pass or fail, and the per-suite counts, not a single bit. This is what makes every later comparison differential rather than absolute. "The tests pass" only tells you the build is not broken right now; "the tests that passed before still pass" is the sentence that catches a regression, and you cannot say it without having written down what passed first. A baseline recorded after the first mutation is not a baseline, it is a second data point with nothing to compare against.

## The budget is fixed before the first mutation

Decide how much you will run before you run anything, and write it down beside the baseline: the list of behaviours the change claims, one mutation per claim, and the wall-clock you will give the whole round. The default is one mutation per claimed behaviour and no more than an hour of suite time for the round, and a suite that takes minutes per run cuts the mutation list rather than stretching the hour. A round with no budget written down cannot know when it is finished, and a loop that cannot know when it is finished runs until its context does, which produces a handoff written by whatever was left. Spend the budget on the claims in order of how much would go wrong if each one were untested, so that if the round stops early the important mutations are the ones already run. When the budget runs out, stop: what is left goes under Not done, named, so the next round can pick it up rather than start over. Never spend the budget on the harness - a scratch tree that will not build or a suite that will not run cleanly twice is a Not done bullet, not a debugging session.

## What counts as a meaningful mutation

A mutation is meaningful when it changes behaviour a test could plausibly notice: invert a condition, delete a guard clause, weaken a comparison from strict to loose, replace a lookup by name with a lookup by position, remove a bounds check. Renaming a variable, reformatting a file, or editing a comment is not a mutation in this sense, because nothing observable changed and a test's silence in the face of it proves nothing. Spend the budget on edits that could plausibly break something a caller depends on, not on edits that were always going to survive because there was never anything for a test to catch.

## A crash is a kill

Treat any non-zero exit from the suite as a kill, never as a survival, and confirm the baseline is green before every single mutant you try. This is not general caution - it corrects a specific and dangerous mistake a naive harness makes by default. A mutation that makes the test process crash - an import error, an unhandled exception during collection, a segfault - produces no failure lines for a harness that greps output for the word "fail" to decide the verdict. Nothing failed, in that literal sense, so a harness reading only for failure lines records the mutant as surviving. But a mutant that crashes the process is the strongest mutation in the set, not the weakest: it broke the code so badly that the tests could not even run against it, which is a more severe outcome than a handful of assertions failing cleanly. On 9 September, in the claudecode-agents repo, exactly that inversion happened - a mutation that crashed the test process was recorded as surviving, which reported the strongest finding of the run as though it were the weakest, or as though there had been no finding at all. Check the exit code before you look at anything else in the output.

## Equivalent mutants are real

Some mutations change no behaviour at all, and no test - written now or written later - can kill one, because there is nothing observable for it to detect. A concrete case from the claudecode-agents repo: a readability check guarding an operation that fails into the same branch either way, so removing the check changes nothing a test can see. Note where the equivalence comes from. The state it screens for is perfectly reachable - a file can be unreadable - and what makes the mutant equivalent is that the guard and the operation behind it share one failure branch, so both paths already return the same thing. Recognising a mutant as equivalent and saying so is the correct answer, not a failure to find something. The wrong move is writing a test to kill it anyway - that test does not verify behaviour, it pins the exact shape of the current implementation, and it will break on the next honest refactor for a reason that has nothing to do with correctness. When you cannot construct a scenario where the mutation and the original disagree, call the mutant equivalent and move on.

## Convergence

Compare this round's findings against the previous round's before starting another. If what survives now is substantially what survived last time, the loop has stopped converging, and another round will not produce a different answer - only the same findings restated with a higher round number attached. Say so, and stop, rather than spending another round's budget to confirm what you already know.

## What the handoff carries

Report the baseline you recorded, the budget you set, every mutation tried and its verdict, the budget consumed and what it did not reach, and the convergence signal - whether this round's findings are new or a repeat of the last one. These are ordinary `## Done` bullets. The handoff format does not change for this skill, only what fills it.
