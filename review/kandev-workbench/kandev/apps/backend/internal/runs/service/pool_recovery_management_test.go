package service_test

import (
	"context"
	"testing"

	runsmodels "github.com/kandev/kandev/internal/runs/models"
	taskmodels "github.com/kandev/kandev/internal/task/models"
	"github.com/stretchr/testify/require"
)

func acquirePoolManager(t *testing.T, f poolPublishFixture, version string) *taskmodels.TaskManagementClaim {
	t.Helper()
	claim, err := f.tasks.ChangeTaskManagementClaim(context.Background(), taskmodels.TaskManagementClaimChange{
		Action: taskmodels.TaskManagementClaimAcquire, TaskID: f.task.ID, WorkspaceID: f.task.WorkspaceID,
		ExpectedTaskResourceVersion: version, InstallationID: "native-test-manager", InstanceKey: "manager",
		ActorID: "pool-human", Reason: "核对恢复管理权",
	})
	require.NoError(t, err)
	return claim
}

func changePoolManager(t *testing.T, f poolPublishFixture, command runsmodels.PoolRecoveryCommand, previous *taskmodels.TaskManagementClaim, action, actor string) *taskmodels.TaskManagementClaim {
	t.Helper()
	claim, err := f.tasks.ChangeTaskManagementClaim(context.Background(), taskmodels.TaskManagementClaimChange{
		Action: action, TaskID: f.task.ID, WorkspaceID: f.task.WorkspaceID,
		ExpectedTaskResourceVersion: command.ExpectedTaskVersion, ExpectedClaimResourceVersion: previous.ResourceVersion,
		OwnerKind: "human", OwnerActorID: actor, ActorID: actor, Reason: "核对原生管理权变更前提",
	})
	require.NoError(t, err)
	return claim
}

// @covers AC-TASKS-AGENT-POOL-005.4
func TestPoolRecoveryWithdrawalManagementOwnerAndVersion(t *testing.T) {
	for _, mode := range []string{"plugin", "other-human", "released-after-confirmation"} {
		t.Run(mode, func(t *testing.T) {
			f := newPoolPublishFixture(t)
			command, before := poolWithdrawal(t, f)
			claim := acquirePoolManager(t, f, command.ExpectedTaskVersion)
			if mode == "other-human" {
				changePoolManager(t, f, command, claim, taskmodels.TaskManagementClaimTransfer, "another-human")
			}
			if mode == "released-after-confirmation" {
				changePoolManager(t, f, command, claim, taskmodels.TaskManagementClaimRelease, "pool-human")
			}
			event, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), f.task.ID, command)
			require.ErrorIs(t, err, runsmodels.ErrPoolRecoveryConflict)
			require.Nil(t, event)
			after, err := f.runs.GetRunByID(context.Background(), before.ID)
			require.NoError(t, err)
			require.Equal(t, before, after, "管理权冲突不能清队列或覆盖领取")
		})
	}
}

func TestPoolRecoveryWithdrawalCurrentHumanManagement(t *testing.T) {
	f := newPoolPublishFixture(t)
	command, _ := poolWithdrawal(t, f)
	claim := acquirePoolManager(t, f, command.ExpectedTaskVersion)
	claim = changePoolManager(t, f, command, claim, taskmodels.TaskManagementClaimTransfer, "pool-human")
	command.ExpectedManagementVersion = claim.ResourceVersion
	event, err := f.svc.RecoverPoolRun(poolRecoveryHuman(), f.task.ID, command)
	require.NoError(t, err)
	require.NotNil(t, event, "同一操作者持有当前原生管理权时，明确动作仍须可用")
}
