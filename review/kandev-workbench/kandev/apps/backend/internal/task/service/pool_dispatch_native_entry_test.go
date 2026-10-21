package service

import (
	"context"
	"fmt"
	"strconv"
	"testing"

	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-001.3
func TestPoolDispatchNativeRepositoryEntryAndLegacySpellingShareOneRun(t *testing.T) {
	f := newTaskPoolFixture(t)
	for index, entry := range []string{strconv.FormatInt(f.entryID, 10), fmt.Sprintf("entry:%020d", f.entryID)} {
		outcome, err := f.publisher.PublishPoolRelease(context.Background(), f.task.ID, f.task.WorkflowStepID, entry)
		require.NoError(t, err)
		if index == 0 {
			require.Equal(t, "queued", string(outcome))
		} else {
			require.Equal(t, "deduped", string(outcome))
		}
	}
	var count int
	require.NoError(t, f.database.Get(&count, `SELECT COUNT(*) FROM runs`))
	require.Equal(t, 1, count)
}
