import type { ReactNode } from "react";
import { Button, ErrorState, LoadingState } from "../components";
import { AsyncState } from "../motion";

export function ResourceState({ loading, error, hasData, refresh }: { loading: boolean; error?: Error; hasData: boolean; refresh: () => Promise<void> }): ReactNode {
  if (!hasData && loading) {
    return <AsyncState status="loading" loading={<LoadingState />} children={null} />;
  }
  if (!error) {
    return null;
  }
  return <AsyncState
    status="error"
    error={(
      <ErrorState
        description={error.message}
        action={<Button type="button" loading={loading} onClick={() => void refresh()}>Retry</Button>}
      />
    )}
    children={null}
  />;
}
