package sqlite

import (
	"strings"
	"testing"

	"github.com/jmoiron/sqlx"
	"github.com/kandev/kandev/internal/db/dialect"
	"github.com/kandev/kandev/internal/task/poolview"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	"github.com/stretchr/testify/require"
)

func TestPoolSummaryRejectsUnsupportedOrUnboundedReadBeforeDatabaseAccess(t *testing.T) {
	postgres := &Repository{db: sqlx.NewDb(nil, dialect.PGX)}
	_, err := postgres.ReadPoolSummarySnapshot(t.Context(), "workspace", []string{"task"})
	require.ErrorIs(t, err, repoerrors.ErrPoolStorageUnsupported)
	sqlite := &Repository{db: sqlx.NewDb(nil, dialect.SQLite3)}
	for _, ids := range [][]string{nil, {""}, {"same", "same"}, {strings.Repeat("x", 257)}, make([]string, 51)} {
		snapshot, err := sqlite.ReadPoolSummarySnapshot(t.Context(), "workspace", ids)
		require.Nil(t, snapshot)
		require.ErrorIs(t, err, poolview.ErrInvalidQuery)
	}
}
