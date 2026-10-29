const jobs = [101, 205, 309];
export const durableAlarmCases = [
  {
    name: "recovered-three",
    jobs,
    actions: [
      "rearm",
      "rearm",
      "cold",
      "alarm",
      "cold",
      "alarm",
      "alarm",
      "rearm",
    ],
  },
  {
    name: "warm-three",
    jobs,
    actions: ["rearm", "rearm", "alarm", "alarm", "alarm", "rearm"],
  },
  { name: "idle", jobs: [], actions: ["rearm", "alarm", "cold", "rearm"] },
  {
    name: "changed-cold",
    jobs,
    actions: ["rearm", "change", "cold", "rearm", "alarm"],
  },
  { name: "held-fire", jobs, actions: ["rearm", "held"] },
  ...["fire", "deadline", "alarm"].map((fault) => ({
    name: `failure-${fault}`,
    jobs,
    fault,
    actions: ["alarm"],
  })),
  { name: "raw-negative", jobs: [-1.5], actions: ["rearm", "rearm", "alarm"] },
];
