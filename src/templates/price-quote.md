# Price quote

Change the quantity, price or discount; the totals update for whoever opens the link.

```calc
input quantity = 3 in 1..1000        // items
input unitPrice = 40 in 0..100000    // price per item
input discount = 10 in 0..100        // percent off
input taxRate = 8 in 0..50           // percent tax
subtotal = quantity * unitPrice
saving = subtotal * discount / 100
taxed = (subtotal - saving) * taxRate / 100
total = subtotal - saving + taxed
```

| | |
|---|---|
| Quantity | :edit[Quantity]{input=quantity step=1} |
| Price per item | \$:edit[Price per item]{input=unitPrice step=1} |
| Discount | :slider[Discount percent]{input=discount step=1} **:value[discount]%** |
| Tax | :edit[Tax percent]{input=taxRate step=0.5} % |
| Subtotal | \$:value[subtotal]{format=fixed:2} |
| Discount | −\$:value[saving]{format=fixed:2} |
| Tax | \$:value[taxed]{format=fixed:2} |
| **Total** | **\$:value[total]{format=fixed:2}** |

*Edit the calc block to change the rules: every line is `name = expression`, and inputs
declare a default and a range.*
