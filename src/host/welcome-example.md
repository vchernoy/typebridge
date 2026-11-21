# Which phone plan is cheaper?

Move the slider to your monthly data use. Both bills and the verdict update as you go.

```calc
input gb = 8 in 0..40              // GB of data a month
input basicFee = 10 in 0..100      // Basic: monthly fee
input included = 5 in 0..40        // Basic: GB included
input extraPrice = 3 in 0..20      // Basic: price per extra GB
input unlimitedFee = 25 in 0..100  // Unlimited: monthly fee
extra = max(gb - included, 0)
basic = basicFee + extra * extraPrice
unlimited = unlimitedFee
saving = abs(basic - unlimited)
breakEven = included + max(unlimitedFee - basicFee, 0) / max(extraPrice, 0.01)
```

I use :slider[Data per month in GB]{input=gb step=1} **:value[gb] GB** a month.

| | Basic | Unlimited |
|---|---|---|
| Monthly fee | \$:edit[Basic monthly fee]{input=basicFee step=1} | \$:edit[Unlimited monthly fee]{input=unlimitedFee step=1} |
| Data included | :edit[Basic GB included]{input=included step=1} GB, then \$:edit[Price per extra GB]{input=extraPrice step=0.5} per GB | everything |
| **Your bill** | **\$:value[basic]{format=fixed:2}** | **\$:value[unlimited]{format=fixed:2}** |

::::::when[basic < unlimited]
:::tip[Basic is cheaper]
You save **\$:value[saving]{format=fixed:2}** a month, or \$:value[saving * 12]{format=fixed:0} a year.
:::
::::::

::::::when[basic > unlimited]
:::tip[Unlimited is cheaper]
You save **\$:value[saving]{format=fixed:2}** a month, or \$:value[saving * 12]{format=fixed:0} a year.
:::
::::::

::::::when[basic == unlimited]
:::note[It's a tie]
Both plans cost \$:value[basic]{format=fixed:2} at this usage.
:::
::::::

:::::details[How the Basic bill is worked out]
$$
\text{Basic} = {{basicFee}} + \max({{gb}} - {{included}},\ 0) \cdot {{extraPrice}} = {{basic | fixed:2}}
$$
::::when[unlimitedFee <= basicFee]
Unlimited never costs more than Basic at these prices.
::::
::::when[unlimitedFee > basicFee]
:::when[extraPrice > 0]
Above about :value[breakEven]{format=fixed:1} GB a month, Unlimited costs less.
:::
:::when[extraPrice <= 0]
Extra data is free, so Basic never costs more than Unlimited at these prices.
:::
::::
:::::

---

*This is a TypeBridge document: Markdown with live calculations, controls and math.
Choose **Edit** to see how it is written, change anything, then **Share document** to send
it as a page the reader can use.*
