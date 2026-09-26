export const revalidate = 60;
export const dynamicParams = false;

export async function generateStaticParams(): Promise<{ slug: string }[]> {
  return [];
}

export default async function BlogPost(): Promise<null> {
  return null;
}
