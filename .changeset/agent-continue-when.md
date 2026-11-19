---
"@demlik/tea": minor
---

**Additive:** `continueWhen` on `createAgent` and `defineAgent` lets a pure rule refuse a turn without tools: return feedback to keep the stage working, or `null` to finish. Feedback is durable as `Conversation.nudges` (`Nudge` is exported), rendered as user messages, retained by the transcript collector and carried on `TurnSettled.nudge`. Refused finishes share the tool-drain turn boundary, including run limits and compaction. Older Models default missing nudges to an empty list. Compaction drops and reindexes nudges with their turns, and tool records now use the producing turn's conversation index after a fold. Omit the gate to keep finishing on the first turn without tools. **Additive (declaration only):** The existing DO host signatures expose the widened experimental agent state and optional event feedback.
