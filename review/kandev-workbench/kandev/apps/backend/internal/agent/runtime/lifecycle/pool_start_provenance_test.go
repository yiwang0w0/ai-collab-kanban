package lifecycle

import (
	"encoding/json"
	"testing"

	"github.com/kandev/kandev/internal/agentctl/types/streams"
)

// @covers AC-TASKS-AGENT-POOL-002.2
func TestPoolTurnStartSourceSurvivesStreamBoundary(t *testing.T) {
	var provider streams.AgentEvent
	if err := json.Unmarshal([]byte(`{"type":"turn_started","operation_id":"provider-turn","prompt_generation":42,"turn_start_source":"codex_provider_turn_started"}`), &provider); err != nil {
		t.Fatal(err)
	}
	encoded, err := json.Marshal(buildAgentStreamEventData(provider))
	if err != nil {
		t.Fatal(err)
	}
	var wire map[string]any
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if wire["turn_start_source"] != "codex_provider_turn_started" || wire["operation_id"] != "provider-turn" || wire["prompt_generation"] != float64(42) {
		t.Fatalf("宿主流边界丢失提供商证据: %s", encoded)
	}
	local := buildAgentStreamEventData(streams.AgentEvent{Type: streams.EventTypeTurnStarted})
	encoded, err = json.Marshal(local)
	if err != nil {
		t.Fatal(err)
	}
	wire = nil
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if _, present := wire["turn_start_source"]; present {
		t.Fatalf("本地提示派发不得补造提供商来源: %s", encoded)
	}
}
