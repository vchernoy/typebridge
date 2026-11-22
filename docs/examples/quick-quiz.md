# Quick quiz

Paste this document into TypeBridge, choose Markdown, and open Preview, then share it
as a rendered page. Readers answer, press **Check** to see their score, and **Retry**
to try again. Answers are not shown on the page, but they are in the document's source
(Edit a copy opens it), so this is a self-check, not a secure test.

```calc
input price = 40 in 1..200
```

A shirt costs \$:value[price]. Change the price and the expected answer follows it:
:edit[Shirt price]{input=price step=1}

:::question{type=number}
How much do three shirts cost?

:answer[3 * price]
:::

:::question{type=single points=2}
Which is larger?

::choice[$2^{10}$]{correct}
::choice[$10^3$]
:::

:::question{type=multiple}
Which numbers are even?

::choice[2]{correct}
::choice[3]
::choice[4]{correct}
:::

::quiz-submit[Check]
