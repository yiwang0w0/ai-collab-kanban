package handlers

import (
	"testing"

	"github.com/stretchr/testify/require"
)

func TestPoolSummaryLoaderReadsNativeClaimOnQueryOnlyConnection(t *testing.T) {
	f := queuedPoolHistoryFixture(t)
	claim, err := f.runs.ClaimNextEligibleRunWithClaim(f.ctx)
	require.NoError(t, err)
	require.NotNil(t, claim)
	_, err = f.database.Exec(`PRAGMA query_only=ON`)
	require.NoError(t, err)
	t.Cleanup(func() { _, err := f.database.Exec(`PRAGMA query_only=OFF`); require.NoError(t, err) })
	before := poolHistorySourceCounts(t, f)
	value, err := poolSummaryService(f).GetPoolExecutionSummary(f.ctx, f.task.ID)
	require.NoError(t, err)
	require.NotNil(t, value)
	require.Equal(t, "claimed", value.State)
	require.Equal(t, claim.ID, value.RunID)
	require.Equal(t, claim.ClaimID, value.ClaimID)
	require.True(t, value.ClaimedAt.Equal(*claim.ClaimedAt))
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}

// @covers AC-TASKS-AGENT-POOL-002.3 AC-TASKS-AGENT-POOL-003.4
func TestPoolSummaryLoaderReadsNativeClearanceOnQueryOnlyConnection(t *testing.T) {
	fixture := newPoolRetentionFixture(t)
	fixture.purge(t)
	f := fixture.f
	_, err := f.database.Exec(`PRAGMA query_only=ON`)
	require.NoError(t, err)
	t.Cleanup(func() { _, err := f.database.Exec(`PRAGMA query_only=OFF`); require.NoError(t, err) })
	before := poolHistorySourceCounts(t, f)
	value, err := poolSummaryService(f).GetPoolExecutionSummary(f.ctx, f.task.ID)
	require.NoError(t, err)
	require.NotNil(t, value)
	require.Equal(t, "unknown", value.State)
	require.Equal(t, "history_cleaned", value.Reason)
	require.Equal(t, fixture.runID, value.RunID)
	require.Equal(t, fixture.claimID, value.ClaimID)
	require.False(t, value.Current)
	require.Nil(t, value.StartedAt)
	require.Equal(t, before, poolHistorySourceCounts(t, f))
}
