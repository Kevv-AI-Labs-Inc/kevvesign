"""Prepare a reversible Azure gateway revision; no Azure API calls or secret reads."""
import argparse
import copy
import json
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("snapshot", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("--image", required=True)
parser.add_argument("--origin-host", required=True)
parser.add_argument("--public-host", default="esign.kevv.ai")
parser.add_argument("--revision", required=True)
args = parser.parse_args()
if "@sha256:" not in args.image:
    parser.error("Use a fixed registry image digest")
if not args.origin_host.endswith(".azurecontainerapps.io") or any(c in args.origin_host for c in "/: "):
    parser.error("Use the verified native Azure application hostname")
old = json.loads(args.snapshot.read_text())
if old["name"] != "ca-web-kevvesign-prod":
    parser.error("This cutover only replaces the existing eSign domain entry point")
config = old["properties"]["configuration"]
if not any(d["name"] == args.public_host and d["bindingType"] == "SniEnabled" for d in config["ingress"]["customDomains"]):
    parser.error("The verified TLS domain binding must already exist in the snapshot")
result = {k: copy.deepcopy(old[k]) for k in ["name", "location", "identity", "tags"] if k in old}
result["tags"] = {**result.get("tags", {}), "application": "documenso-gateway", "engine": "documenso"}
config = copy.deepcopy(config)
config["activeRevisionsMode"] = "Single"
config["ingress"]["targetPort"] = 8080
config["ingress"]["allowInsecure"] = False
config["ingress"]["traffic"] = [{"latestRevision": True, "weight": 100}]
result["properties"] = {
    "environmentId": old["properties"]["environmentId"],
    "configuration": config,
    "template": {
        "revisionSuffix": args.revision,
        "containers": [{
            "name": "web", "image": args.image,
            "env": [{"name": "DOCUMENSO_ORIGIN_HOST", "value": args.origin_host}, {"name": "PUBLIC_SIGNING_HOST", "value": args.public_host}, {"name": "DNS_RESOLVER", "value": "168.63.129.16"}],
            "resources": {"cpu": 0.25, "memory": "0.5Gi"},
            "probes": [
                {"type": "Liveness", "httpGet": {"path": "/health/gateway", "port": 8080, "scheme": "HTTP"}, "initialDelaySeconds": 20, "periodSeconds": 30, "timeoutSeconds": 5, "failureThreshold": 5},
                {"type": "Readiness", "httpGet": {"path": "/api/health", "port": 8080, "scheme": "HTTP"}, "initialDelaySeconds": 20, "periodSeconds": 15, "timeoutSeconds": 10, "failureThreshold": 10},
            ],
        }],
        "scale": {"minReplicas": 1, "maxReplicas": 2},
    },
}
args.output.write_text(json.dumps(result, indent=2) + "\n")
args.output.chmod(0o600)
print("Prepared gateway-only revision; existing domain, certificate, registry access and configuration preserved.")
