const blindBackrunJSON = require('./utils/BlindBackrunFlashLoan.json')//added flashloan instead of pure arbitrage 
const ethers = require('ethers')
const Web3EthAbi = require('web3-eth-abi')
const config = require('./utils/config.json')

class BundleExecutor {
    constructor(_signer, _flashbotsBundleProvider, _contractAddress, _bundleAPI, _percentageToKeep) {
        this.signer = _signer
        this.flashBotsBundleProvider = _flashbotsBundleProvider
        this.contract = new ethers.Contract(_contractAddress, blindBackrunJSON.abi, this.signer);
        this.connectionInfo = {
            url: _bundleAPI,
        }
        this.relayEndpoints = [
            { name: 'Flashbots', url: 'https://relay.flashbots.net' },
            { name: 'BloXroute Max Profit', url: 'https://mev.bloXroute.com' },
            { name: 'BloXroute Regulated', url: 'https://bloxroute.regulated.ethereum.blocknative.com' },
            { name: 'Blocknative', url: 'https://api.blocknative.com/v1/auction' },
            { name: 'Manifold', url: 'https://mainnet-relay.securerpc.com' },
            { name: 'BuildAI', url: 'https://builder0x69.io' },
            { name: 'Titan', url: 'https://rpc.titanbuilder.xyz' },
            { name: 'Rsync', url: 'https://rsync-builder.xyz' },
            { name: 'Beaver Build', url: 'https://rpc.beaverbuild.org' },
            { name: 'Lightspeed', url: 'https://rpc.lightspeedbuilder.info' },
            { name: 'EdenNetwork', url: 'https://api.edennetwork.io/v1/bundle' }
        ]
        
        this.nextID = 1
        this.percentageToKeep = _percentageToKeep
        
        console.log('✅ Successfully created BundleExecutor')
    }

    /**
     * Executes arbitrage by sending bundles to multiple relays simultaneously.
     * @param {string} _firstPair - The first pair's address.
     * @param {string} _secondPair - The second pair's address.
     * @param {string} _txHash - The transaction hash to execute the bundles on.
     */
    async execute(_firstPair, _secondPair, _txHash) {
        console.log("🚀 Sending bundles for tx:", _txHash)
        const [bundleOneWithParams, bundleTwoWithParams] = await this.buildBundles(_firstPair, _secondPair, _txHash)
        
        // Send to multiple relays simultaneously for better inclusion
        await this.sendBundleToMultipleRelays(bundleOneWithParams, bundleTwoWithParams)
    }

    /**
     * Sends bundles to multiple MEV relays simultaneously.
     * @param {Object} _bundleOneWithParams - The first bundle with parameters.
     * @param {Object} _bundleTwoWithParams - The second bundle with parameters.
     */
    async sendBundleToMultipleRelays(_bundleOneWithParams, _bundleTwoWithParams) {
        const relayPromises = []
        
        // Send to primary relay (MEV-Share)
        relayPromises.push(
            this.sendBundle(_bundleOneWithParams, this.connectionInfo.url),
            this.sendBundle(_bundleTwoWithParams, this.connectionInfo.url)
        )
        
        // Also send to alternative relays for redundancy
        for (const relay of this.relayEndpoints.slice(0, 3)) {
            relayPromises.push(
                this.sendBundle(_bundleOneWithParams, relay.url).catch(e => 
                    console.log(`⚠️ ${relay.name} failed:`, e.message)
                ),
                this.sendBundle(_bundleTwoWithParams, relay.url).catch(e => 
                    console.log(`⚠️ ${relay.name} failed:`, e.message)
                )
            )
        }
        
        await Promise.allSettled(relayPromises)
    }

    /**
     * Sends a bundle to a specific relay.
     * @param {Object} _bundle - The bundle to send.
     * @param {string} _relayUrl - The relay URL to send to.
     * @returns {Promise<Object>} The response from sending the bundle.
     */
    async sendBundle(_bundle, _relayUrl = this.connectionInfo.url) {
        const request = JSON.stringify(this.prepareRelayRequest([_bundle], 'mev_sendBundle'))
        const response = await this.request(request, _relayUrl)
        console.log(`📥 Response from ${_relayUrl}:`, response)
        return response
    }

    /**
     * Prepares a relay request with the given method and parameters.
     * @param {Array} _params - The parameters for the relay request.
     * @param {string} _method - The method for the relay request.
     * @returns {Object} The prepared relay request.
     */
    prepareRelayRequest(_params, _method) {  
        return {
            method: _method,
            params: _params,
            id: this.nextID++,
            jsonrpc: '2.0'
        }
    }

    /**
     * Sends a request with the specified payload.
     * @param {string} _request - The request payload.
     * @param {string} _relayUrl - The relay URL to send to.
     * @returns {Promise<Object>} The response from the request.
     */
    async request(_request, _relayUrl = this.connectionInfo.url) {
        const connectionInfo = {
            url: _relayUrl,
            headers: {
                'X-Flashbots-Signature': `${await this.signer.address}:${await this.signer.signMessage(ethers.utils.id(_request))}`
            }
        }
        
        console.log("📡 Making request to:", _relayUrl)
        let resp = await ethers.utils.fetchJson(connectionInfo, _request)
        return resp
    }
    
    /**
     * Builds bundles for the given pair addresses and transaction hash.
     * @dev This function outputs two bundles, one for each potential trade direction. Only one will succeed depending on the direction of the user's trade.
     * @param {string} _firstPair - The first pair's address.
     * @param {string} _secondPair - The second pair's address.
     * @param {string} _txHash - The transaction hash to backrun.
     * @returns {Promise<Array>} An array containing two bundles backrunning the user's _txHash.
     */
    async buildBundles(_firstPair, _secondPair, _txHash) {
        let blockNumber = Number(await this.signer.provider.getBlockNumber())
        console.log("🔢 Current block number:", blockNumber)
        console.log("🏗️ Building bundles")

        // Get current gas price from multiple sources for better accuracy
        const gasPrice = await this.getOptimalGasPrice()

        let bundleTransactionOptions = {
            gasPrice: gasPrice,
            gasLimit: ethers.BigNumber.from(400000),
            nonce: await this.signer.getTransactionCount(),
        } 

        const types = ['address', 'address', 'uint256']
        
        const valuesFirstTrade = [_firstPair, _secondPair, this.percentageToKeep]
        let paramsFirstTrade = Web3EthAbi.encodeParameters(types, valuesFirstTrade)

        let bundleOneTransaction = await this.contract.populateTransaction.makeFlashLoan(
            [config.mainnetWETHAddress],
            [ethers.utils.parseEther("10")],
            paramsFirstTrade,
            bundleTransactionOptions
        );

        let bundleOne = [
            {hash: _txHash},
            {tx: await this.signer.signTransaction(bundleOneTransaction), canRevert: false},
        ]

        const valuesSecondTrade = [_secondPair, _firstPair, this.percentageToKeep]
        let paramsSecondTrade = Web3EthAbi.encodeParameters(types, valuesSecondTrade)

        let bundleTwoTransaction = await this.contract.populateTransaction.makeFlashLoan(
            [config.mainnetWETHAddress],
            [ethers.utils.parseEther("10")],
            paramsSecondTrade,
            bundleTransactionOptions
        );
        
        let bundleTwo = [
            {hash: _txHash},
            {tx: await this.signer.signTransaction(bundleTwoTransaction), canRevert: false},
        ]
        
        // Reduce maxBlock window for faster inclusion (3 blocks instead of 10)
        const bundleOneWithParams = this.bundleWithParams(blockNumber + 1, 3, bundleOne)
        const bundleTwoWithParams = this.bundleWithParams(blockNumber + 1, 3, bundleTwo)
        return [bundleOneWithParams, bundleTwoWithParams]
    }

    /**
     * Gets optimal gas price by checking current network conditions.
     * @returns {Promise<BigNumber>} The optimal gas price.
     */
    async getOptimalGasPrice() {
        try {
            const feeData = await this.signer.provider.getFeeData()
            // Use base fee + priority fee if available (EIP-1559)
            if (feeData.maxFeePerGas && feeData.maxPriorityFeePerGas) {
                return feeData.maxFeePerGas
            }
            // Fallback to legacy gas price with 10% buffer
            const gasPrice = await this.signer.provider.getGasPrice()
            return gasPrice.mul(110).div(100)
        } catch (e) {
            console.log("⚠️ Error getting gas price, using fallback")
            return await this.signer.provider.getGasPrice()
        }
    }
    
    /**
     * Adds parameters to a bundle for the given block number and blocks to try.
     * @notice The version number might need to change in the future. This is the only one that works at the moment.
     * @param {number} _blockNumber - The block number to submit initially for.
     * @param {number} _blocksToTry - The number of blocks to try.
     * @param {Array} _bundle - The bundle to add parameters to.
     * @returns {Object} The bundle with parameters.
     */
    bundleWithParams(_blockNumber, _blocksToTry, _bundle) {
        console.log("📦 Submitting bundles for block:", _blockNumber, "through block:", _blockNumber + _blocksToTry)
        
        return {
            version: "beta-1",
            inclusion: {
                block: ethers.utils.hexValue(_blockNumber),
                maxBlock: ethers.utils.hexValue(_blockNumber + _blocksToTry)
            },
            body: _bundle,
        }
    }
}

module.exports = BundleExecutor
