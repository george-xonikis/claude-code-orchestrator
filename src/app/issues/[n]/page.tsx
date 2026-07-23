import { IssueDetail } from '@/components/issue-detail';

export default async function IssuePage({ params }: { params: Promise<{ n: string }> }) {
  const { n } = await params;
  return <IssueDetail issueNumber={Number(n)} />;
}
