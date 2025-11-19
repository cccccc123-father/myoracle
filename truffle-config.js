module.exports = {
  networks: {
    development: {
      // host and port should match the RPC Server address
      // as seen in Ganache
      host: "127.0.0.1",
      port: 8545,
      network_id: "*",
    },
	  poa:{
		  host:"127.0.0.1",
		  port:8545,
		  network_id:"1001",
		  gas:7000000
             },
},
  compilers: {
    solc: {
      version: "^0.8.19",
      settings: {
        optimizer: {
        enabled: true, // Default: false
        runs: 200, // Default: 200
        },
	      evmVersion:"paris",
	      viaIR:true
      }
    }
  }
};
