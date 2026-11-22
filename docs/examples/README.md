# Active Markdown examples

Use TypeBridge with the published ActiveMD 0.8.0 controls. Copy a calculator into
the editor, choose Documents → Format → Markdown, then open Preview. Share it as
a rendered page to let recipients use the same controls.

- [Delivery choices](delivery-choices.md): radio buttons, a dropdown and number
  field synchronized to one delivery input.
- [Trip budget](trip-budget.md): radio travel choices and a lodging dropdown,
  with readable numeric fields, a slider and dependent per-person costs.
- [Phone plans](phone-plans.md): a form-like comparison; monthly data use and
  both plans' prices drive the two bills, a conditional verdict and the
  break-even point.
- [Quick quiz](quick-quiz.md): numeric, single- and multiple-choice questions
  with Check, Retry and a score; one answer follows a live calculator value.

Author new number fields as `:edit[Accessible name]{input=name}` and sliders as
`:slider[Accessible name]{input=name step=1}`. Bracket names are accessible-only;
write visible wording in the surrounding prose. Radio/select brackets label the
visible group and options. Declare defaults in calc, not on controls; a choice
input's default must match an option. Keep `:value[total]` for output values.

Accepted values save separately from source when storage policy permits. Reset
inputs restores calc defaults. Share current values only by explicitly enabling
that option in Share. No control change edits the authored Markdown.
