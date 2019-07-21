function update_colors(){
	pokemon_buttons = document.getElementsByClassName('pokemon_button')
	for (var i = pokemon_buttons.length - 1; i >= 0; i--) {
		//Missing EVs
		hp_missing = document.getElementById('hp_obj').value-document.getElementById('hp_act').value;
		atk_missing = document.getElementById('atk_obj').value-document.getElementById('atk_act').value;
		def_missing = document.getElementById('def_obj').value-document.getElementById('def_act').value;
		spa_missing = document.getElementById('spa_obj').value-document.getElementById('spa_act').value;
		spd_missing = document.getElementById('spd_obj').value-document.getElementById('spd_act').value;
		spe_missing = document.getElementById('spe_obj').value-document.getElementById('spe_act').value;

		if(parseInt(pokemon_buttons[i].getAttribute('hp')) > hp_missing){
			//HP
			pokemon_buttons[i].style.backgroundColor = 'indianred';
		} else if(parseInt(pokemon_buttons[i].getAttribute('atk')) > atk_missing){
			//ATK
			pokemon_buttons[i].style.backgroundColor = 'indianred';
		} else if(parseInt(pokemon_buttons[i].getAttribute('def')) > def_missing){
			//DEF
			pokemon_buttons[i].style.backgroundColor = 'indianred';
		} else if(parseInt(pokemon_buttons[i].getAttribute('spa')) > spa_missing){
			//SPA
			pokemon_buttons[i].style.backgroundColor = 'indianred';
		} else if(parseInt(pokemon_buttons[i].getAttribute('spd')) > spd_missing){
			//SPD
			pokemon_buttons[i].style.backgroundColor = 'indianred';
		} else if(parseInt(pokemon_buttons[i].getAttribute('spe')) > spe_missing){
			//SPE
			pokemon_buttons[i].style.backgroundColor = 'indianred';
		} else {
			pokemon_buttons[i].style.backgroundColor = 'lightgreen';
		};
	}
};
function display_pokemon(){
	document.getElementById(document.getElementById('pokemon_list').value).style.display='block';
	document.getElementById('pokemon_list').value = '';
};
function add_effort_values(pokemon_id){
	if(confirm("Add EVs from "+pokemon_id+"?")){
		document.getElementById('hp_act').value = parseInt(document.getElementById('hp_act').value) + parseInt(document.getElementById(pokemon_id).getAttribute('hp'));
		document.getElementById('atk_act').value = parseInt(document.getElementById('atk_act').value) + parseInt(document.getElementById(pokemon_id).getAttribute('atk'));
		document.getElementById('def_act').value = parseInt(document.getElementById('def_act').value) + parseInt(document.getElementById(pokemon_id).getAttribute('def'));
		document.getElementById('spa_act').value = parseInt(document.getElementById('spa_act').value) + parseInt(document.getElementById(pokemon_id).getAttribute('spa'));
		document.getElementById('spd_act').value = parseInt(document.getElementById('spd_act').value) + parseInt(document.getElementById(pokemon_id).getAttribute('spd'));
		document.getElementById('spe_act').value = parseInt(document.getElementById('spe_act').value) + parseInt(document.getElementById(pokemon_id).getAttribute('spe'));
		update_colors();
	}
};