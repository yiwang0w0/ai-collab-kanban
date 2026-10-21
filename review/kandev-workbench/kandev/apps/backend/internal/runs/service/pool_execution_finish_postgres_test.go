package service_test

import (
	"context"
	"testing"

	settingsstore "github.com/kandev/kandev/internal/agent/settings/store"
	"github.com/kandev/kandev/internal/common/logger"
	officesqlite "github.com/kandev/kandev/internal/office/repository/sqlite"
	"github.com/kandev/kandev/internal/orchestrator"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	runsservice "github.com/kandev/kandev/internal/runs/service"
	"github.com/kandev/kandev/internal/task/repository/repoerrors"
	taskrepo "github.com/kandev/kandev/internal/task/repository/sqlite"
	"github.com/kandev/kandev/internal/testutil"
	"github.com/stretchr/testify/require"
)

// @covers AC-TASKS-AGENT-POOL-005.2
func TestPoolExecutionFinishPostgresRemainsUnavailable(t *testing.T) {
	database := testutil.OpenIsolatedPostgres(t, testutil.PostgresDSNFromEnv(t))
	_, _, err := settingsstore.Provide(database, database, nil)
	require.NoError(t, err)
	tasks, err := taskrepo.NewWithDB(database, database, nil)
	require.NoError(t, err)
	office, err := officesqlite.NewWithDB(database, database, nil)
	require.NoError(t, err)
	svc := runsservice.New(office.RunsRepository(), nil, logger.Default(), nil)
	svc.SetPoolReleaseSource(tasks)
	svc.SetPoolEnqueueAdmission(&poolFinishAdmission{Service: &orchestrator.Service{}})
	ctx := context.Background()
	identity := runsmodels.PoolExecutionIdentity{RunID: "unsupported-run", ClaimID: "unsupported-claim", TaskID: "unsupported-task"}
	event, err := svc.FinalizeStoppedPoolRun(ctx, identity)
	require.ErrorIs(t, err, runsmodels.ErrPoolAdmissionUnavailable)
	require.Nil(t, event)
	tx, err := database.BeginTxx(ctx, nil)
	require.NoError(t, err)
	defer func() { _ = tx.Rollback() }()
	require.ErrorIs(t, tasks.CheckPoolExecutionQuiescentTx(ctx, tx, identity), repoerrors.ErrPoolStorageUnsupported)
	event, err = office.RunsRepository().FinalizeStoppedPoolRunTx(ctx, tx, identity)
	require.ErrorIs(t, err, runsmodels.ErrPoolAdmissionUnavailable)
	require.Nil(t, event)
}
