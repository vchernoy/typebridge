# Quick self-check

Pick an answer; the feedback appears right away.

```calc
input answer = 0 in 0..3
```

:::radio[Which is larger, 2¹⁰ or 10³?]{input=answer}
::option[Not answered yet]{value=0}
::option[2¹⁰]{value=1}
::option[10³]{value=2}
::option[They are equal]{value=3}
:::

::::when[answer == 1]
:::tip[Correct]
2¹⁰ = 1024, which is a little more than 10³ = 1000.
:::
::::

::::when[answer >= 2]
:::note[Not quite]
Work it out: 2¹⁰ = 1024 and 10³ = 1000.
:::
::::

*Add more questions the same way: one calc input per question, a radio group, and a
`when` block for each kind of feedback.*
