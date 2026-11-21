# The area of a circle

A circle of radius $r$ has area

$$
A = \pi r^2
$$

Try it: drag the radius and watch the formula fill in.

```calc
input r = 3 in 0..20
area = pi * r ^ 2
circumference = 2 * pi * r
```

Radius :slider[Radius]{input=r step=0.5} **:value[r]**

$$
A = \pi \cdot {{r}}^2 \approx {{area | fixed:2}}
$$

The circumference is $2\pi r \approx$ :value[circumference]{format=fixed:2}.

:::tip[Notice]
Doubling the radius makes the area four times larger, because $r$ is squared.
:::

*Write your own lesson: keep the formula in `$$ … $$`, put live values in `{{…}}`,
and declare the numbers a reader may change in the calc block.*
