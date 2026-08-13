import { useState } from "react";
import { Alert, Button, message, Modal, Progress, Tooltip } from "antd";
import { DownloadOutlined } from "@ant-design/icons";
import { useObservable } from "../utils/UseObservable";
import { minecraftJar } from "../logic/MinecraftApi";
import { decompilerSplits, decompilerThreads, displayLambdas } from "../logic/Settings";
import { getDecompilerOptions } from "../logic/Decompiler";
import { decompileEntireJar, setOptions, type DecompileEntireJarTask } from "../workers/decompile/client";
import { downloadSourceZip } from "../logic/SourceExport";

type Phase = "confirm" | "decompiling" | "packaging";

export const DownloadSourceButton = () => {
    const jar = useObservable(minecraftJar);
    const [open, setOpen] = useState(false);
    const [phase, setPhase] = useState<Phase>("confirm");
    const [currentClass, setCurrentClass] = useState("");
    const [current, setCurrent] = useState(0);
    const [total, setTotal] = useState(0);
    const [task, setTask] = useState<DecompileEntireJarTask>();
    const [messageApi, contextHolder] = message.useMessage();

    const reset = () => {
        setOpen(false);
        setPhase("confirm");
        setTask(undefined);
        setCurrent(0);
        setTotal(0);
    };

    const stop = () => {
        task?.stop();
        reset();
    };

    const start = async () => {
        if (!jar) return;
        setPhase("decompiling");

        const startTime = performance.now();
        await setOptions(getDecompilerOptions(displayLambdas.value));

        const decompileTask = decompileEntireJar(jar.jar, {
            threads: decompilerThreads.value,
            splits: decompilerSplits.value,
            logger: (className, current, total) => {
                setCurrentClass(className);
                setCurrent(current);
                setTotal(total);
            },
        });

        setTask(decompileTask);
        try {
            await decompileTask.start();
        } finally {
            setTask(undefined);
        }

        setPhase("packaging");
        setCurrent(0);

        const count = await downloadSourceZip(jar, (current, total) => {
            setCurrent(current);
            setTotal(total);
        });

        const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
        messageApi.success(`Downloaded ${count} classes as a ZIP in ${elapsed}s.`);
        reset();
    };

    const percent = total > 0 ? (current / total) * 100 : 0;
    const running = phase !== "confirm";

    return (
        <>
            {contextHolder}
            <Tooltip title="Download all decompiled source as a ZIP">
                <Button
                    data-testid="download-source"
                    icon={<DownloadOutlined />}
                    onClick={() => setOpen(true)}
                >
                    Download
                </Button>
            </Tooltip>
            <Modal
                title="Download Source"
                open={open}
                closable={!running}
                keyboard={!running}
                mask={{ closable: !running }}
                onOk={start}
                onCancel={running ? stop : reset}
                okText="Download"
                okButtonProps={{ "data-testid": "download-source-ok" }}
                footer={running
                    ? <Button danger onClick={stop} data-testid="download-source-stop">Stop</Button>
                    : undefined}
            >
                {phase === "confirm" && jar && (
                    <Alert
                        type="warning"
                        showIcon
                        title={`Download every class in ${jar.version} as a ZIP of .java files.`}
                        description="Classes that haven't been decompiled yet are decompiled first. This can take a long time and use a large amount of memory for newer versions."
                    />
                )}
                {running && (
                    <>
                        <div
                            data-testid="download-source-progress-text"
                            style={{
                                fontFamily: "monospace",
                                fontSize: "small",
                                overflow: "hidden",
                                textOverflow: "ellipsis",
                                whiteSpace: "nowrap",
                            }}
                        >
                            {phase === "decompiling" ? `Decompiling ${currentClass}` : "Packaging..."}
                        </div>
                        <Progress percent={percent} format={() => `${current}/${total}`} />
                    </>
                )}
            </Modal>
        </>
    );
};
