package service_test

import (
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func (f poolPublishFixture) seedTerminalPoolRun(t *testing.T, runID string) {
	t.Helper()
	// 只构造持久存量，不把通用取消冒充领取核验或实际停止／人工恢复。
	result, err := f.runs.Writer().Exec(`UPDATE runs SET status = 'cancelled', finished_at = ?
		WHERE id = ? AND status IN ('queued', 'claimed')`, time.Now().UTC(), runID)
	require.NoError(t, err)
	count, err := result.RowsAffected()
	require.NoError(t, err)
	require.EqualValues(t, 1, count)
}
