# Trip budget

Plan a short trip. Travel is charged per person; the room rate is per room per
night. Change the radio choice or lodging menu and compare the total.

```calc
input travelers = 2 in 1..8
input nights = 3 in 1..14
input travel = 40 in 0..120
input roomRate = 80 in 40..140
rooms = ceil(travelers / 2)
lodging = rooms * nights * roomRate
total = lodging + travelers * travel
perPerson = total / travelers
```

For :edit[Travelers]{input=travelers step=1} travelers, stay
:slider[Nights]{input=nights step=1} nights.

:::radio[Travel per person]{input=travel}
::option[Walk or cycle — 0]{value=0}
::option[Train — 40]{value=40}
::option[Flight — 120]{value=120}
:::

:::select[Room rate per night]{input=roomRate}
::option[Hostel — 40]{value=40}
::option[Guesthouse — 80]{value=80}
::option[Hotel — 140]{value=140}
:::

The same room-rate binding can be edited here: :edit[Room rate]{input=roomRate}.
Only the three listed rates are accepted; the menu and number field stay in sync.

- Rooms (two travelers per room): :value[rooms]
- Lodging: :value[lodging]{format=fixed:2}
- **Trip total: :value[total]{format=fixed:2}**
- **Per traveler: :value[perPerson]{format=fixed:2}**

Try Flight and Hotel: for two travelers and three nights the total is 660.00,
or 330.00 each. Calc owns the defaults (Train and Guesthouse), regardless of
option order. A host's Reset inputs action restores those defaults; changing
controls never rewrites the Markdown source. These are numeric calculator
choices, not quiz answers or checkbox collections.
