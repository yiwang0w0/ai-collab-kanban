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

func TestPoolProjectionRejectsPostgresBeforeDatabaseAccess(t *testing.T) {
	repository := &Repository{db: sqlx.NewDb(nil, dialect.PGX)}
	snapshot, err := repository.ReadPoolProjectionSnapshot(t.Context(), "workspace", poolview.Query{Limit: 50})
	require.Nil(t, snapshot)
	require.ErrorIs(t, err, repoerrors.ErrPoolStorageUnsupported)
}

func TestPoolProjectionRejectsUnboundedRepositoryInputBeforeDatabaseAccess(t *testing.T) {
	repository := &Repository{db: sqlx.NewDb(nil, dialect.SQLite3)}
	for _, query := range []poolview.Query{{Limit: 0}, {Limit: 51}, {Limit: 50, After: strings.Repeat("x", 257)}} {
		snapshot, err := repository.ReadPoolProjectionSnapshot(t.Context(), "workspace", query)
		require.Nil(t, snapshot)
		require.ErrorIs(t, err, poolview.ErrInvalidQuery)
	}
}
