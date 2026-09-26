export default function Post(): null {
  return null;
}

export async function getStaticPaths(): Promise<{ paths: string[]; fallback: boolean }> {
  return { paths: [], fallback: false };
}

export const getStaticProps = async (): Promise<{ props: object }> => ({ props: {} });
