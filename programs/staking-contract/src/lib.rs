use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken, 

    token::{ Token, Transfer, TokenAccount, Mint}
};
use anchor_lang::require;

declare_id!("Fg6PaFpoGXkYsidMpWTK6W2BeZ7FEfcYkg476zPFsLnS");

#[program]
pub mod staking_contract {
    use super::*;

    pub fn perform_action(
        ctx: Context<PerformAction>,
        action_amount: u64, 
        action_token: Pubkey,
        stake_action: bool
    ) -> Result<()> {
       let current_user = ctx.accounts.staker.clone();
       let token_program = ctx.accounts.token_mint.clone();
    
       let token_mint_key = ctx.accounts.token_mint.clone().key();
       let current_staking_pool_account = ctx.accounts.current_staking_pool.clone().to_account_info();
       let staking_pool = &mut ctx.accounts.current_staking_pool;
       let pool_action = &mut ctx.accounts.pool_action;

       require!(token_program.key() == action_token, ErrorCode::InvalidToken);  

       if stake_action {

        pool_action.staker = current_user.key();
        pool_action.token_amount = action_amount;
        pool_action.mint_start_time = 7u64; //For testing

        let transfer_instruction = Transfer{
            from: ctx.accounts.staker_associated_address.to_account_info(),
            to: ctx.accounts.staking_vault_associated_address.to_account_info(),
            authority: ctx.accounts.staker.to_account_info(),
        };
        let cpi_ctx = CpiContext::new(
            ctx.accounts.token_program.to_account_info(),
            transfer_instruction,
        );
        anchor_spl::token::transfer(cpi_ctx, action_amount)?;

        pool_action.staking_action = true;
        staking_pool.token_amount += action_amount;
       }

       else {
        
        require!(pool_action.staker == ctx.accounts.staker.key(), ErrorCode::InvalidUser);
        require!(pool_action.token_amount >= action_amount && staking_pool.token_amount >= action_amount, ErrorCode::NotEnoughToken);
        require!(pool_action.staking_action , ErrorCode::InvalidPoolAction);

        pool_action.token_amount -= action_amount;

         let bump_seed_staking_pool = ctx.bumps.get("current_staking_pool").unwrap().to_le_bytes();
         let staking_pool_signer_seeds: &[&[_]] = &[
            b"stake_pool".as_ref(),
            &token_mint_key.as_ref(),
            &bump_seed_staking_pool
        ];

        let transfer_instruction = Transfer{
            from: ctx.accounts.staking_vault_associated_address.to_account_info(),
            to: ctx.accounts.staker_associated_address.to_account_info(),
            authority: current_staking_pool_account.clone(),
        };
        let signer = &[staking_pool_signer_seeds];
        let cpi_ctx = CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            transfer_instruction,
            signer,
            );
        anchor_spl::token::transfer(cpi_ctx, action_amount)?;

        pool_action.staking_action = false;
        staking_pool.token_amount -= action_amount;

       }
       Ok(())
    }
}

#[derive(Accounts)]
#[instruction(action_amount: u64, action_token: Pubkey, stake_action: bool)]
pub struct PerformAction<'info> {
    #[account(mut)]
    staker: Signer<'info>, 

    #[account(
        init_if_needed,
        payer = staker,
        space = 8 + 32 + 8,
        seeds = [
            b"stake_pool".as_ref(),
            token_mint.key().as_ref()
        ],
        bump
    )]
    current_staking_pool: Account<'info, StakePool>,

    #[account(
        init_if_needed,
        payer = staker, 
        space = 8 + 32 + 8 + 8 + 1
    )]
    pool_action: Account<'info, PoolAction>,

    #[account(
        init_if_needed,
        payer = staker,
        associated_token::mint = token_mint,
        associated_token::authority = current_staking_pool,
    )]
    staking_vault_associated_address: Box<Account<'info, TokenAccount>>,

    #[account(
         mut,
        constraint= staker_associated_address.owner == staker.key(),
        constraint= staker_associated_address.mint == token_mint.key(),
    )]
    staker_associated_address: Box<Account<'info, TokenAccount>>,

    token_mint: Account<'info, Mint>,

    associated_token_program: Program<'info, AssociatedToken>,
    system_program: Program<'info, System>,
    token_program: Program<'info, Token>,
    rent: Sysvar<'info, Rent>

}

#[account]
#[derive(Default)]
pub struct StakePool {
    token_mint: Pubkey,
    token_amount: u64
}

#[account]
#[derive(Default)]
pub struct PoolAction{
    staker: Pubkey,
    token_amount: u64,
    mint_start_time: u64,
    staking_action: bool,
}


#[error_code]
pub enum ErrorCode {

    #[msg("Not Enough Token")]
    NotEnoughToken,

    #[msg("Not Valid Token")]
    InvalidToken, 

    #[msg("Not Valid User")]
    InvalidUser, 

    #[msg("Not Valid Pool Action Acccount Provided")]
    InvalidPoolAction, 
    
}