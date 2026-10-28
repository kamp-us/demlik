// Frozen actual Source comparison views and compiled native calls. Raw reporters remain in the report.
export const snapshotMessagesAdmissionData = {
  "agent-snapshot-messages.promise.single": {
    sourceViewSHA256:
      "c87a0a860f4a8c6a71e12f962f198c5e9ffcb55d331faf04a709e6747bdc3ab8",
    nativeCalls: [
      "demlik_tea::agent::Agent::to_machine_with_snapshot_messages",
      "runtime::try_launch",
      "runtime::Runtime::ready",
      "demlik_tea::agent::AgentMachineMsg::cancel",
      "runtime::Runtime::stop",
    ],
  },
  "agent-snapshot-messages.promise.ordered": {
    sourceViewSHA256:
      "6c0f7d5e355a3810bbca785f1f2a9cdea810efb56649e9d7c59700a3756042bd",
    nativeCalls: [
      "demlik_tea::agent::Agent::to_machine_with_snapshot_messages_and_compaction",
      "runtime::try_launch",
      "runtime::Runtime::ready",
      "Schema::parse",
      "demlik_tea::agent::AgentMachineMsg::cancel",
      "runtime::Runtime::stop",
    ],
  },
  "agent-snapshot-messages.promise.cold": {
    sourceViewSHA256:
      "2db9c89c95cf79124d2ad767d7c10bcaaff6c712f6c7936a484942d2f664d3b7",
    nativeCalls: [
      "demlik_tea::agent::Agent::to_machine_with_snapshot_messages_and_compaction",
      "runtime::try_launch",
      "runtime::Runtime::ready",
      "Schema::parse",
      "demlik_tea::agent::Agent::to_machine_with_snapshot_messages_and_compaction",
      "runtime::try_launch",
      "runtime::Runtime::ready",
      "demlik_tea::agent::AgentMachineMsg::cancel",
      "runtime::Runtime::stop",
    ],
  },
  "agent-snapshot-messages.promise.held-stop": {
    sourceViewSHA256:
      "361f92d99fb98c4ceb21e4d740bfd0a2ac78a8ceb54ebe523a55893921efc8cf",
    nativeCalls: [
      "demlik_tea::agent::Agent::to_machine_with_snapshot_messages",
      "runtime::try_launch",
      "runtime::Runtime::ready",
      "demlik_tea::agent::AgentMachineMsg::cancel",
    ],
  },
  "agent-snapshot-messages.promise.writer-fail": {
    sourceViewSHA256:
      "c57c54b46cc2ac1d2d25d5c2d701e457e0e5fe4bf0c0b6669e4dc43d83549a79",
    nativeCalls: [
      "demlik_tea::agent::Agent::to_machine_with_snapshot_messages_and_compaction",
      "runtime::try_launch",
      "runtime::Runtime::ready",
      "Schema::parse",
      "runtime::Runtime::stop",
    ],
  },
  "agent-snapshot-messages.effect.single": {
    sourceViewSHA256:
      "c87a0a860f4a8c6a71e12f962f198c5e9ffcb55d331faf04a709e6747bdc3ab8",
    nativeCalls: [
      "demlik_tea::agent::Agent::to_machine_with_snapshot_messages",
      "runtime::try_launch",
      "runtime::Runtime::ready",
      "demlik_tea::agent::AgentMachineMsg::cancel",
      "runtime::Runtime::stop",
    ],
  },
  "agent-snapshot-messages.effect.ordered": {
    sourceViewSHA256:
      "6c0f7d5e355a3810bbca785f1f2a9cdea810efb56649e9d7c59700a3756042bd",
    nativeCalls: [
      "demlik_tea::agent::Agent::to_machine_with_snapshot_messages_and_compaction",
      "runtime::try_launch",
      "runtime::Runtime::ready",
      "Schema::parse",
      "demlik_tea::agent::AgentMachineMsg::cancel",
      "runtime::Runtime::stop",
    ],
  },
  "agent-snapshot-messages.effect.cold": {
    sourceViewSHA256:
      "2db9c89c95cf79124d2ad767d7c10bcaaff6c712f6c7936a484942d2f664d3b7",
    nativeCalls: [
      "demlik_tea::agent::Agent::to_machine_with_snapshot_messages_and_compaction",
      "runtime::try_launch",
      "runtime::Runtime::ready",
      "Schema::parse",
      "demlik_tea::agent::Agent::to_machine_with_snapshot_messages_and_compaction",
      "runtime::try_launch",
      "runtime::Runtime::ready",
      "demlik_tea::agent::AgentMachineMsg::cancel",
      "runtime::Runtime::stop",
    ],
  },
  "agent-snapshot-messages.effect.held-stop": {
    sourceViewSHA256:
      "5913d500ed2afe0a03637e1423e7dc4964dca2502ac41bab7653936814009f82",
    nativeCalls: [
      "demlik_tea::agent::Agent::to_machine_with_snapshot_messages",
      "runtime::try_launch",
      "runtime::Runtime::ready",
    ],
  },
  "agent-snapshot-messages.effect.writer-fail": {
    sourceViewSHA256:
      "c57c54b46cc2ac1d2d25d5c2d701e457e0e5fe4bf0c0b6669e4dc43d83549a79",
    nativeCalls: [
      "demlik_tea::agent::Agent::to_machine_with_snapshot_messages_and_compaction",
      "runtime::try_launch",
      "runtime::Runtime::ready",
      "Schema::parse",
      "runtime::Runtime::stop",
    ],
  },
};
