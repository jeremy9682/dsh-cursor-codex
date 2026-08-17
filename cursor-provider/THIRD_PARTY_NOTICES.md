# Third-party notices

This package interoperates with and depends on the following independently licensed projects:

- [`agent-virtualization`](https://github.com/VitaTsui/agent-virtualization), MIT License. The DSH adapter's model-provider framing and suspend/resume lifecycle follow that project's public `agent-virtualization/model-provider/v1` protocol.
- [`dsh-llm-agent-virtualization`](https://github.com/VitaTsui/dsh-llm-agent-virtualization), MIT License. Its DeepSeek Harness adapter informed the process lifecycle and bridge-state design.
- [`dsh-cursor-acp`](https://github.com/loeanxi/dsh-cursor-acp), MIT License. Its secret-free Cursor executable resolution and login-health approach informed this package.
- [`@agentclientprotocol/sdk`](https://github.com/agentclientprotocol/typescript-sdk), Apache License 2.0.

The dependencies retain their own license files in installed packages. No Cursor credential, account identity, or proprietary Cursor source is included.
