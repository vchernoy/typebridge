# Delivery calculator

Paste this document into TypeBridge, choose Markdown, and open Preview. The
radio group, dropdown, and number control all edit the same delivery cost. Named Calc constants supply the default, range
and option values.

```calc
pickup = 0
standard = 10
express = standard + 15
input delivery = standard in pickup..express
total = 100 + delivery
```

:::radio[Delivery]{input=delivery}
::option[Standard]{value=standard}
::option[Express]{value=express}
::option[Pickup]{value=pickup}
:::

:::select[Delivery menu]{input=delivery}
::option[Standard]{value=standard}
::option[Express]{value=express}
::option[Pickup]{value=pickup}
:::

Total: **:value[total]**.

The same binding can also be edited numerically: :edit[Delivery cost]{input=delivery}.
Only the listed values are accepted while this document is mounted.
