# Delivery calculator

Paste this document into TypeBridge, choose Markdown, and open Preview. The
radio group, dropdown, and number control all edit the same delivery cost.
Named Calc constants supply the default, range, and option values. Each label
uses `{{value | fixed:2}}` to display its own option cost and stays the same
when the selection changes. The total updates live and uses `fixed`, shorthand
for `fixed:0`, to display a whole number.

```calc
pickup = 0
standard = 10
express = standard + 15
input delivery = standard in pickup..express
total = 100.25 + delivery
```

:::radio[Delivery]{input=delivery}
::option[Standard (+{{value | fixed:2}})]{value=standard}
::option[Express (+{{value | fixed:2}})]{value=express}
::option[Pickup (+{{value | fixed:2}})]{value=pickup}
:::

:::select[Delivery menu]{input=delivery}
::option[Standard (+{{value | fixed:2}})]{value=standard}
::option[Express (+{{value | fixed:2}})]{value=express}
::option[Pickup (+{{value | fixed:2}})]{value=pickup}
:::

Total: **:value[total]{format=fixed}**.

The same binding can also be edited numerically: :edit[Delivery cost]{input=delivery}.
Only the listed values are accepted while this document is mounted.
