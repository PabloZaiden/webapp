import type { ReactNode } from "react";
import { Button, ErrorState, LoadingState } from "../components";

export function ResourceState({ loading, error, hasData, refresh }: { loading: boolean; error?: Error; hasData: boolean; refresh: () => Promise<void> }): ReactNode {
  if (!hasData && loading) {
    return <LoadingState />;
  }
  if (!error) {
    return null;
  }
  return (
    <ErrorState
      description={error.message}
      action={<Button type="button" loading={loading} onClick={() => void refresh()}>Retry</Button>}
    />
  );
}
