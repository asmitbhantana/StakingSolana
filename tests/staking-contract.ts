import * as anchor from "@project-serum/anchor";
import { Program } from "@project-serum/anchor";
import { StakingContract } from "../target/types/staking_contract";

import * as spl from "@solana/spl-token";
import { assert, expect } from "chai";

interface PDAParameters {
  stake_pool: anchor.web3.PublicKey;
}

describe("Stake", () => {
  const provider = anchor.AnchorProvider.local();
  anchor.setProvider(provider);

  const program = anchor.workspace.StakingContract as Program<StakingContract>;

  let mintAddress: anchor.web3.PublicKey;

  let alice: anchor.web3.Keypair;
  let bob: anchor.web3.Keypair;
  let aliceTokenAccount: anchor.web3.PublicKey;
  let bobTokenAccount: anchor.web3.PublicKey;

  let pda: PDAParameters;
  let pool_action_account: anchor.web3.Keypair;

  let stakingVaultAssociatedAddress: anchor.web3.PublicKey;

  //get PDA of Stake Pool
  const getPdaParams = async (
    token_program: anchor.web3.PublicKey
  ): Promise<PDAParameters> => {
    let [stake_pool, stake_bump] =
      await anchor.web3.PublicKey.findProgramAddress(
        [Buffer.from("stake_pool"), token_program.toBuffer()],
        program.programId
      );

    return {
      stake_pool: stake_pool,
    };
  };

  //Create a SPL Token
  const createMint = async (): Promise<anchor.web3.PublicKey> => {
    const tokenMint = new anchor.web3.Keypair();
    const lamportsForMint =
      await provider.connection.getMinimumBalanceForRentExemption(
        spl.MintLayout.span
      );
    let tx = new anchor.web3.Transaction();

    // Allocate mint
    tx.add(
      anchor.web3.SystemProgram.createAccount({
        programId: spl.TOKEN_PROGRAM_ID,
        space: spl.MintLayout.span,
        fromPubkey: provider.wallet.publicKey,
        newAccountPubkey: tokenMint.publicKey,
        lamports: lamportsForMint,
      })
    );
    // Allocate wallet account
    tx.add(
      spl.createInitializeMintInstruction(
        tokenMint.publicKey,
        6,
        provider.wallet.publicKey,
        provider.wallet.publicKey,
        spl.TOKEN_PROGRAM_ID
      )
    );
    const signature = await provider.sendAndConfirm(tx, [tokenMint]);

    // console.log(`[${tokenMint.publicKey}] Created new mint account at ${signature}`);
    return tokenMint.publicKey;
  };

  //Create a User Associated Wallet for SPL Tokens
  const createUserAndAssociatedWallet = async (
    mint: anchor.web3.PublicKey,
    amount: number
  ): Promise<[anchor.web3.Keypair, anchor.web3.PublicKey | undefined]> => {
    const user = new anchor.web3.Keypair();
    let userAssociatedTokenAccount: anchor.web3.PublicKey | undefined =
      undefined;

    // Fund user with some SOL
    let txFund = new anchor.web3.Transaction();
    txFund.add(
      anchor.web3.SystemProgram.transfer({
        fromPubkey: provider.wallet.publicKey,
        toPubkey: user.publicKey,
        lamports: 5 * anchor.web3.LAMPORTS_PER_SOL,
      })
    );
    const sigTxFund = await provider.sendAndConfirm(txFund);
    //console.log(`[${user.publicKey.toBase58()}] Funded new account with 5 SOL: ${sigTxFund}`);

    if (mint) {
      // Create a token account for the user and mint some tokens
      userAssociatedTokenAccount = await spl.getAssociatedTokenAddress(
        mint,
        user.publicKey,
        false,
        spl.TOKEN_PROGRAM_ID,
        spl.ASSOCIATED_TOKEN_PROGRAM_ID
      );
      const txFundTokenAccount = new anchor.web3.Transaction();
      txFundTokenAccount.add(
        spl.createAssociatedTokenAccountInstruction(
          user.publicKey,
          userAssociatedTokenAccount,
          user.publicKey,
          mint,
          spl.TOKEN_PROGRAM_ID,
          spl.ASSOCIATED_TOKEN_PROGRAM_ID
        )
      );
      txFundTokenAccount.add(
        spl.createMintToInstruction(
          mint,
          userAssociatedTokenAccount,
          provider.wallet.publicKey,
          amount,
          [],
          spl.TOKEN_PROGRAM_ID
        )
      );
      const txFundTokenSig = await provider.sendAndConfirm(txFundTokenAccount, [
        user,
      ]);
      // console.log(`[${userAssociatedTokenAccount.toBase58()}] New associated account for mint ${mint.toBase58()}: ${txFundTokenSig}`);
    }
    return [user, userAssociatedTokenAccount];
  };

  const readAccount = async (
    accountPublicKey: anchor.web3.PublicKey
  ): Promise<[string]> => {
    const tokenInfoLol = await provider.connection.getAccountInfo(
      accountPublicKey
    );
    const data = Buffer.from(tokenInfoLol.data);
    const accountInfo: spl.AccountInfo = spl.AccountLayout.decode(data);
    return [accountInfo.amount.toString()];
  };

  before(async () => {
    pool_action_account = new anchor.web3.Keypair();
    //c8 mint token
    mintAddress = await createMint();
    //transfer token to alice
    [alice, aliceTokenAccount] = await createUserAndAssociatedWallet(
      mintAddress,
      20000000
    );

    [bob, bobTokenAccount] = await createUserAndAssociatedWallet(
      mintAddress,
      20000000
    );

    // //c8 program state account and program's token account
    pda = await getPdaParams(mintAddress);
    //check before calling program
    let aliceBalance = await readAccount(aliceTokenAccount);
    assert.equal(aliceBalance, "20000000");

    stakingVaultAssociatedAddress = await spl.getAssociatedTokenAddress(
      mintAddress,
      pda.stake_pool,
      true,
      spl.TOKEN_PROGRAM_ID,
      spl.ASSOCIATED_TOKEN_PROGRAM_ID
    );
  });

  it("Staking", async () => {
    let staking_amount = "20000000";
    let staking_token = mintAddress;
    let stake_action = true;

    let pool_action_entry = new anchor.web3.Keypair();

    await program.rpc.performAction(
      new anchor.BN(staking_amount),
      staking_token,
      stake_action,
      {
        accounts: {
          staker: alice.publicKey,
          tokenMint: mintAddress,
          currentStakingPool: pda.stake_pool,
          poolAction: pool_action_account.publicKey,
          poolEntry: pool_action_entry.publicKey,
          stakerAssociatedAddress: aliceTokenAccount,
          stakingVaultAssociatedAddress: stakingVaultAssociatedAddress,
          associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: spl.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        },
        // signers: [alice],
        signers: [alice, pool_action_account, pool_action_entry],
      }
    );
    let aliceBalance = await readAccount(aliceTokenAccount);
    assert.equal(aliceBalance, "0");

    let stakingVaultBalance = await readAccount(stakingVaultAssociatedAddress);
    assert.equal(stakingVaultBalance, staking_amount);
  });

  it("Unstaking", async () => {
    let un_staking_amount = "5000000";
    let staking_token = mintAddress;
    let stake_action = false;

    let pool_action_entry = new anchor.web3.Keypair();

    await program.rpc.performAction(
      new anchor.BN(un_staking_amount),
      staking_token,
      stake_action,
      {
        accounts: {
          staker: alice.publicKey,
          tokenMint: mintAddress,
          currentStakingPool: pda.stake_pool,
          poolAction: pool_action_account.publicKey,
          poolEntry: pool_action_entry.publicKey,
          stakerAssociatedAddress: aliceTokenAccount,
          stakingVaultAssociatedAddress: stakingVaultAssociatedAddress,
          associatedTokenProgram: spl.ASSOCIATED_TOKEN_PROGRAM_ID,
          tokenProgram: spl.TOKEN_PROGRAM_ID,
          systemProgram: anchor.web3.SystemProgram.programId,
          rent: anchor.web3.SYSVAR_RENT_PUBKEY,
        },
        signers: [alice, pool_action_account, pool_action_entry],
      }
    );

    let stakingVaultBalance = await readAccount(stakingVaultAssociatedAddress);
    assert.equal(stakingVaultBalance, "15000000");

    let aliceBalance = await readAccount(aliceTokenAccount);
    assert.equal(aliceBalance, un_staking_amount);
  });
});
