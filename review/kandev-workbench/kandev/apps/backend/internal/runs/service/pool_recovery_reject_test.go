package service_test

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/kandev/kandev/internal/auth/authn"
	runsmodels "github.com/kandev/kandev/internal/runs/models"
	"github.com/stretchr/testify/require"
)

func TestPoolRecoveryWithdrawalRequiresBrowserHuman(t *testing.T) {
	for _, identity := range []authn.Identity{
		{}, {UserID: "pool-human", Role: authn.RoleAdmin},
		{UserID: "pool-human", SessionID: "browser-session", Synthetic: true},
		{UserID: "pool-human", SessionID: "browser-session", TokenID: "pat"},
	} {
		f := newPoolPublishFixture(t)
		command, run := poolWithdrawal(t, f)
		ctx := authn.WithIdentity(context.Background(), identity)
		event, err := f.svc.RecoverPoolRun(ctx, f.task.ID, command)
		require.ErrorIs(t, err, runsmodels.ErrPoolRecoveryConfirmation)
		require.Nil(t, event)
		after, err := f.runs.GetRunByID(context.Background(), run.ID)
		require.NoError(t, err)
		require.Equal(t, run, after)
	}
}

func TestPoolRecoveryWithdrawalFencesTaskAndRunVersions(t *testing.T) {
	for _, field := range []string{"task", "run", "no-confirmation", "bad-operation"} {
		t.Run(field, func(t *testing.T) {
			f := newPoolPublishFixture(t)
			command, before := poolWithdrawal(t, f)
			want := runsmodels.ErrPoolRecoveryConflict
			switch field {
			case "task":
				command.ExpectedTaskVersion = time.Now().Add(-time.Hour).UTC().Format(time.RFC3339Nano)
			case "run":
				command.ExpectedRunVersion = strings.Repeat("a", 64)
			case "no-confirmation":
				command.Confirm = false
				want = runsmodels.ErrPoolRecoveryConfirmation
			case "bad-operation":
				command.OperationID = "not-a-nonce"
				want = runsmodels.ErrPoolRecoveryInvalid
			}
			event, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), f.task.ID, command)
			require.ErrorIs(t, err, want)
			require.Nil(t, event)
			after, err := f.runs.GetRunByID(context.Background(), before.ID)
			require.NoError(t, err)
			require.Equal(t, before, after)
		})
	}
}

func TestPoolRecoveryWithdrawalOperationBodyCannotChange(t *testing.T) {
	f := newPoolPublishFixture(t)
	command, run := poolWithdrawal(t, f)
	first, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), f.task.ID, command)
	require.NoError(t, err)
	command.ExpectedRunVersion = strings.Repeat("a", 64)
	second, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), f.task.ID, command)
	require.ErrorIs(t, err, runsmodels.ErrPoolRecoveryConflict)
	require.Nil(t, second)
	events, err := f.runs.ListRunEvents(context.Background(), run.ID, -1, 50)
	require.NoError(t, err)
	require.Len(t, events, 1)
	require.Equal(t, first, events[0])
}
