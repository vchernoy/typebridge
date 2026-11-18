# Phone layout and waiting updates (#304)

The original failing 390px CI trace showed a “New version available” notice above
the editor. It did not show a font request. That is evidence of the visible state,
not proof of the service-worker event sequence that produced it. #307 addressed
stale notices after external activation; #345 covered unavailable font downloads.

The update notice is an in-flow surface. A genuine waiting worker intentionally
moves the editor down while offering Reload and Not now. The ordinary phone-layout
limits (editor y < 340 at 320px, < 300 at 390px) still apply before the notice and
after dismissal; they must not be relaxed to accommodate an unexplained banner.

`e2e/update-notice.spec.ts` now exercises a late waiting update through the actual
notice controller at 320px and 390px, with normal and enlarged browser text. It
checks both actions' bounds/touch height, no horizontal overflow, continued editing,
no activation on dismissal, preserved text and restoration of the prior editor
position. Content-free geometry is attached to each test result. Service-worker
transport is simulated; the notice/controller, application and layout are real.

These cases guard legitimate-banner behavior and its removal. They do not establish
the original CI trigger or justify closing #304 as root-cause resolved.
