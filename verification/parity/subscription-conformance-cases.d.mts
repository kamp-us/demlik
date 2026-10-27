export const subscriptionScenarios: [string, ...string[]];
export const subscriptionCases: {
  id: string;
  input: {
    profile: string;
    scenario: string;
    policy: string;
    origin: string;
    verb: string;
  };
}[];
export const invalidSubscriptionRequests: unknown[];
