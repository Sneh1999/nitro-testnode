import { ethers, BigNumber } from "ethers";
import * as fs from 'fs';
import { hideBin } from 'yargs/helpers';
import yargs from 'yargs/yargs';
import { createClient } from '@node-redis/client';
const path = require("path");

const l1keystore = "/l1keystore"
const l1passphrase = "passphrase"
const configpath = "/config"

const redisUrl = "redis://redis:6379"
const l1url = "ws://geth:8546"

async function createSendTransaction(provider: ethers.providers.Provider, from: ethers.Wallet, to: string, value: ethers.BigNumberish, data: ethers.BytesLike): Promise<ethers.providers.TransactionResponse> {
    const nonce = await provider.getTransactionCount(from.address, "latest");
    const chainId = (await provider.getNetwork()).chainId

    let transactionRequest: ethers.providers.TransactionRequest = {
        type: 2,
        from: from.address,
        to: to,
        value: value,
        data: data,
        nonce: nonce,
        chainId: chainId,
    }
    const gasEstimate = await provider.estimateGas(transactionRequest)

    let feeData = await provider.getFeeData();
    if (feeData.maxPriorityFeePerGas == null || feeData.maxFeePerGas == null) {
        throw Error("bad L1 fee data")
    }
    transactionRequest.gasLimit = BigNumber.from(Math.ceil(gasEstimate.toNumber() * 1.2))
    transactionRequest.maxPriorityFeePerGas = BigNumber.from(Math.ceil(feeData.maxPriorityFeePerGas.toNumber() * 1.2)) // Recommended maxPriorityFeePerGas
    transactionRequest.maxFeePerGas = BigNumber.from(Math.ceil(feeData.maxFeePerGas.toNumber() * 1.2))

    const signedTx = await from.signTransaction(transactionRequest)

    return provider.sendTransaction(signedTx)
}

async function writeRedisPriorities(priorities: number) {
    const redis = createClient({url: redisUrl})

    let prio_sequencers = "bcd"
    let priostring = ""
    if (priorities == 0) {
        priostring = "ws://sequencer:7546"
    }
    if (priorities > prio_sequencers.length) {
        priorities = prio_sequencers.length
    }
    for (let index = 0; index < priorities; index++) {
        const this_prio = "ws://sequencer_" + prio_sequencers.charAt(index) + ":7546"
        if (index != 0) {
            priostring = priostring + ","
        }
        priostring = priostring + this_prio
    }
    await redis.connect()

    await redis.set("coordinator.priorities", priostring)
    readRedis("coordinator.priorities")
}

async function readRedis(key: string) {
    const redis = createClient({url: redisUrl})
    await redis.connect()

    const val = await redis.get(key)
    console.log("redis[%s]:%s", key, val)
}

function writeConfigs(sequenceraddress: string, validatoraddress: string) {
    const baseConfig = {
        "l1": {
            "deployment": "/config/deployment.json",
            "url": l1url,
            "wallet": {
                "account": "",
                "password": l1passphrase,
                "pathname": l1keystore,
            },
        },
        "node": {
            "archive": true,
            "forwarding-target": "null",
            "validator": {
                "dangerous": {
                    "without-block-validator": false
                },
                "disable-challenge": false,
                "enable": false,
                "staker-interval": "10s",
                "strategy": "MakeNodes",
                "target-machine-count": 4,
            },
            "sequencer": {
                "enable": false
            },
            "seq-coordinator": {
                "enable": false,
                "redis-url": redisUrl,
                "lockout-duration": "30s",
                "lockout-spare": "1s",
                "my-url": "",
                "retry-interval": "0.5s",
                "seq-num-duration": "24h0m0s",
                "update-interval": "3s",
                "signing-key": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
              },          
        },
        "persistent": {
            "data": "/data"
        },
        "ws": {
            "addr": "0.0.0.0"
        },
        "http": {
            "addr": "0.0.0.0"
        },
    }
    const baseConfJSON = JSON.stringify(baseConfig)

    let validatorConfig = JSON.parse(baseConfJSON)
    validatorConfig.l1.wallet.account = validatoraddress
    validatorConfig.node.validator.enable = true
    let validconfJSON = JSON.stringify(validatorConfig)
    fs.writeFileSync(path.join(configpath, "validator_config.json"), validconfJSON)

    let unsafeStakerConfig = JSON.parse(validconfJSON)
    unsafeStakerConfig.node.validator.dangerous["without-block-validator"] = true
    fs.writeFileSync(path.join(configpath, "unsafe_staker_config.json"), JSON.stringify(unsafeStakerConfig))

    let sequencerConfig = JSON.parse(baseConfJSON)
    sequencerConfig.l1.wallet.account = sequenceraddress
    sequencerConfig.node.sequencer.enable = true
    sequencerConfig.node["seq-coordinator"].enable = true
    fs.writeFileSync(path.join(configpath, "sequencer_config.json"), JSON.stringify(sequencerConfig))
}

async function bridgeFunds(provider: ethers.providers.Provider, from: ethers.Wallet, ethamount: string): Promise<ethers.providers.TransactionResponse> {
    const deploydata = JSON.parse(fs.readFileSync(path.join(configpath, "deployment.json")).toString())
    return createSendTransaction(provider, from, deploydata.Inbox, ethers.utils.parseEther(ethamount), "0x0f4d14e9000000000000000000000000000000000000000000000000000082f79cd90000")
}

async function main() {
    const argv = yargs(hideBin(process.argv)).options({
        writeconfig: { type: 'boolean', describe: 'write config' },
        bridgefunds: { type: 'boolean', describe: 'bridge funds' },
        ethamount: { type: 'string', describe: 'amount to transfer (in eth)', default: "10" },
        l1account: { choices: ["funnel", "sequencer", "validator"] as const, default: "funnel" },
        l1fund: { type: 'boolean', describe: 'send funds from funnel' },
        printaddress: { type: 'boolean', describe: 'print address' },
        initredisprios: { type: 'number', describe: 'initialize redis priorities (0-only one, 1-3 using priorities)' },
        readredis: { type: 'string', describe: 'read redis key' }
    }).help().parseSync()

    let keyFilenames = fs.readdirSync(l1keystore)
    keyFilenames.sort()

    let chosenAccount = 0
    if (argv.l1account == "sequencer") {
        chosenAccount = 1
    }
    if (argv.l1account == "validator") {
        chosenAccount = 2
    }

    let accounts = keyFilenames.map((filename) => {
        return ethers.Wallet.fromEncryptedJsonSync(fs.readFileSync(path.join(l1keystore, filename)).toString(), l1passphrase)
    })

    let provider = new ethers.providers.WebSocketProvider(l1url)

    if (argv.l1fund) {
        let response = await createSendTransaction(provider, accounts[0], accounts[chosenAccount].address, ethers.utils.parseEther(argv.ethamount), new Uint8Array())
        console.log("sent " + argv.l1account + " funding")
        console.log(response)
    }

    if (argv.writeconfig) {
        writeConfigs(accounts[1].address, accounts[2].address)
        console.log("config files written")
    }

    if (argv.bridgefunds) {
        let response = await bridgeFunds(provider, accounts[chosenAccount], argv.ethamount)
        console.log("bridged funds")
        console.log(response)
    }

    if (argv.initredisprios != undefined) {
        await writeRedisPriorities(argv.initredisprios)
    }

    if (argv.readredis != undefined) {
        await readRedis(argv.readredis)
    }

    if (argv.printaddress) {
        console.log(accounts[chosenAccount].address)
    }
    provider.destroy()
}

main()
    .then(() => process.exit(0))
    .catch(error => {
        console.error(error)
        process.exit(1)
    })
