---
name: Bad value
when: Something saves, shows or sends the wrong value, a missing field, or a value of the wrong type
---

# Bad value

The value was right somewhere and wrong later. Find the first place it went wrong.

1. Pick the trip that shows the problem. With `get_action`, list every place the value passes: the click, the request body, the server function's arguments, the database query's parameters, the response.
2. Open each of those with `get_event` in order, from the click forward. Write down the value at each one.
3. The first place where the value is missing, renamed, or a different type is the cause. Usually it is a field name that one side spells differently (`user` vs `userId`), a string where a number is expected, or a default that hides a missing value.
4. Read the code at that file:line with `read_file` to confirm the line that reads or builds the value.
5. Fix the reader, not the writer, unless the writer is clearly wrong everywhere. Change one line if you can.
6. If the project has a rule worth keeping (for example "userId is always a number"), save it with `remember`, tied to the file and line.
