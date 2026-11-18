"""Pass a controller-written DynamoDB item through the real alarm adapter, offline."""

import io
import json
import os
import sys
from pathlib import Path
from unittest.mock import Mock, patch

from boto3.dynamodb.types import TypeDeserializer


def check_selection(case):
    item = case["item"]
    prepared = case["publication"]
    candidate = case["candidateId"]
    assert candidate == prepared["candidateId"]
    table = "IncidentTriageDemoControllerRunFixture"
    expected_key = {"pk": "AGENT_SELECTION"}
    native_key = {"pk": {"S": "AGENT_SELECTION"}}
    reads = []

    def read(request, *, low_level):
        assert request["Key"] == (native_key if low_level else expected_key)
        assert request["ConsistentRead"] is True
        if low_level:
            assert request["TableName"] == table
        reads.append(request)
        if low_level:
            return {"Item": item}
        decode = TypeDeserializer().deserialize
        return {"Item": {name: decode(value) for name, value in item.items()}}

    native = Mock(spec=["get_item"])
    native.get_item.side_effect = lambda **request: read(request, low_level=True)
    resource_table = Mock(spec=["get_item"])
    resource_table.get_item.side_effect = lambda **request: read(request, low_level=False)
    resource = Mock(spec=["Table"])

    def open_table(name):
        assert name == table
        return resource_table

    resource.Table.side_effect = open_table
    runtime = Mock(spec=["invoke_agent_runtime"])
    runtime.invoke_agent_runtime.return_value = {"statusCode": 200, "response": io.BytesIO(b"{}")}
    alarm = prepared["alarmArn"]
    region, account = alarm.split(":")[3:5]
    event = {
        "source": "aws.cloudwatch", "alarmArn": alarm, "accountId": account, "region": region,
        "alarmData": {"state": {"value": "ALARM", "timestamp": "2026-11-18T14:01:00Z"}},
    }
    settings = {
        "AWS_REGION": region, "AWS_DEFAULT_REGION": region, "AWS_EC2_METADATA_DISABLED": "true",
        "AWS_ENDPOINT_URL": "http://127.0.0.1:9",
        "AGENT_RUNTIME_ARN": prepared["runtimeArn"], "AGENT_ALARM_ARN": alarm,
        "AGENT_SELECTION_TABLE": table,
    }
    sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "agent"))
    with (
        patch.dict(os.environ, settings, clear=True),
        patch("boto3.client", side_effect=lambda service, **_: {"dynamodb": native, "bedrock-agentcore": runtime}[service]),
        patch("boto3.resource", side_effect=lambda service, **_: {"dynamodb": resource}[service]),
    ):
        import alarm_adapter

        alarm_adapter.handler(event, None)

    assert len(reads) == 1, "a valid controller selection must be read from DynamoDB"
    runtime.invoke_agent_runtime.assert_called_once()
    invoked = runtime.invoke_agent_runtime.call_args.kwargs
    assert invoked["qualifier"] == candidate
    assert invoked["agentRuntimeArn"] == prepared["runtimeArn"]
    forwarded = json.loads(invoked["payload"])
    assert forwarded["event"] == event
    assert forwarded["deployment"] == {
        key: prepared[key] for key in
        ("runtimeArn", "runtimeVersion", "endpointName", "sourceRevision", "artifactSha256")
    }


if __name__ == "__main__":
    check_selection(json.load(sys.stdin))
